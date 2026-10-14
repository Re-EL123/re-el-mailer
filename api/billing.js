/**
 * /api/billing — subscriptions and the provider webhook (ITN).
 *
 *   subscription · checkout · verify · cancel · webhook
 *
 * The entitlement logic never lives here: a successful payment only writes a
 * subscription row, and `effectivePlan` (../packages/billing/plans.js) decides
 * what that row grants. The provider is pluggable (../packages/billing/provider.js)
 * so the hot paths are identical whether checkout is on or off.
 *
 * A checkout writes a `pending` subscription that grants nothing. Only a
 * signature-checked webhook promotes it to `active`, so a customer cannot
 * upgrade themselves by starting a checkout and stopping. PayFast's browser
 * return carries no trustworthy proof of payment, so `verify` no longer trusts a
 * query string — it simply re-reads the subscription and the frontend polls it
 * until the ITN lands.
 */

import { createHandler } from '../packages/http/pipeline.js';
import { rawBodyBestEffort } from '../packages/http/body.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { logger } from '../packages/shared/logger.js';
import { billing as billingConfig } from '../packages/shared/config.js';
import { plan as planById } from '../packages/billing/plans.js';
import { billingProvider } from '../packages/billing/provider.js';
import {
  findSubscriptionByProviderRef,
  findWorkspaceForUser,
  getWorkspace,
  recordBillingEvent,
  upsertSubscription,
} from '../packages/db/workspaces.js';
import { findByEmail } from '../packages/db/users.js';
import { loadWorkspaceContext, subscriptionView, workspaceView } from '../packages/http/workspace-views.js';
import { billingCheckoutSchema, idSchema } from '../packages/validation/schemas.js';

/** Cap for the signed webhook body; provider callbacks are small. */
const WEBHOOK_MAX_BYTES = 256 * 1024;

/** Absolute origin of the current request, used to build the ITN notify URL. */
function requestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return null;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

/** Everything the billing screen needs for the current workspace. */
async function subscriptionDetail(session, requestedId) {
  const context = await loadWorkspaceContext(session, requestedId);
  return {
    workspace: workspaceView(context.workspace, { role: context.role }),
    role: context.role,
    plan: context.effective,
    subscription: subscriptionView(context.subscription),
    seats: context.seats,
    usage: context.usage,
    configured: billingProvider().configured,
    provider: billingProvider().name,
    currency: billingConfig.currency(),
  };
}

/**
 * Only a platform administrator may manage the organisation's billing. The org
 * is billed, not its members, and the same authority that governs the domain
 * governs its subscription.
 */
function assertBillingAdmin(session) {
  if (session.user.role === 'admin') return;
  throw new AppError(Codes.ADMIN_REQUIRED, 'Only an administrator can manage billing.', 403);
}

/**
 * Find the workspace a normalised provider event refers to.
 *
 * Metadata is authoritative when present; otherwise fall back to the stored
 * subscription (by its provider reference) and finally to the customer email.
 */
async function resolveEventWorkspace(event, providerName) {
  if (event.metadata?.workspaceId) {
    const workspace = await getWorkspace(event.metadata.workspaceId);
    if (workspace) return workspace;
  }
  if (event.providerRef) {
    const subscription = await findSubscriptionByProviderRef(providerName, event.providerRef);
    if (subscription) return getWorkspace(subscription.workspace_id);
  }
  if (event.customer) {
    const user = await findByEmail(event.customer);
    if (user) return findWorkspaceForUser(user.id);
  }
  return null;
}

/**
 * Apply a normalised event to a workspace subscription.
 *
 * @returns {Promise<{applied: boolean, workspaceId?: string, reason?: string}>}
 */
async function applyEvent(event) {
  const providerName = billingProvider().name;
  const workspace = await resolveEventWorkspace(event, providerName);
  if (!workspace) return { applied: false, reason: 'workspace_not_found' };

  const patch = {
    provider: providerName,
    status: event.status,
    // Never leave plan_id undefined: the column is not nullable and a webhook
    // that predates metadata must not insert a null plan.
    planId: event.metadata?.planId || workspace.plan_id || 'solo',
  };
  const seats = Number(event.metadata?.seats);
  if (Number.isFinite(seats) && seats > 0) patch.seats = Math.floor(seats);
  if (event.providerRef) patch.providerRef = event.providerRef;
  if (event.customerRef) patch.providerCustomer = event.customerRef;
  if (event.currentPeriodEnd) patch.currentPeriodEnd = event.currentPeriodEnd;

  await upsertSubscription(workspace.id, patch);
  return { applied: true, workspaceId: workspace.id };
}

/** Reject an ITN whose gross amount does not match the plan it claims. */
function assertEventAmount(event) {
  if (!Number.isFinite(event.amountGross)) return;
  const plan = event.metadata?.planId ? planById(event.metadata.planId) : null;
  if (!plan) return;
  const seats = Number(event.metadata?.seats) || 1;
  const expected = (plan.pricePerSeat * seats) / 100;
  // Payment statuses other than COMPLETE may legitimately carry a 0 or partial
  // amount, so only guard the money-moving one.
  if (event.status !== 'active') return;
  if (Math.abs(expected - event.amountGross) > 0.01) {
    throw new AppError(Codes.SIGNATURE_INVALID, 'Payment amount does not match the selected plan.', 400);
  }
}

export const actions = {
  subscription: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => subscriptionDetail(ctx.session, ctx.query.id || null),
  },

  checkout: {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: billingCheckoutSchema.extend({ workspaceId: idSchema.optional() }),
    handler: async (ctx) => {
      const workspaceId = String(ctx.body.workspaceId || ctx.query.id || '').trim();
      const context = await loadWorkspaceContext(ctx.session, workspaceId || null);
      assertBillingAdmin(ctx.session);

      const provider = billingProvider();
      if (!provider.configured) {
        throw new AppError(Codes.VALIDATION_ERROR, 'Billing is not configured on this deployment.', 400);
      }
      if (ctx.body.planId === 'solo') {
        throw new AppError(Codes.VALIDATION_ERROR, 'The free plan does not need a checkout.');
      }

      const plan = planById(ctx.body.planId);
      const seats = ctx.body.seats || 1;
      const reference = `reel_${context.workspace.id}_${Date.now()}`;

      const origin = requestOrigin(ctx.req);
      if (!origin) {
        throw new AppError(Codes.VALIDATION_ERROR, 'Could not determine the notification URL for this request.');
      }

      const callbackUrl = ctx.body.callbackUrl;
      const checkout = await provider.createCheckout({
        email: ctx.session.user.email,
        amountMinor: plan.pricePerSeat * seats,
        reference,
        metadata: { workspaceId: context.workspace.id, planId: plan.id, seats },
        returnUrl: callbackUrl,
        cancelUrl: callbackUrl,
        notifyUrl: `${origin}/api/billing?action=webhook`,
        recurring: true,
        nameFirst: ctx.session.user.display_name,
      });

      // Pending: records intent and the reference, but grants nothing.
      await upsertSubscription(context.workspace.id, {
        provider: provider.name,
        status: 'pending',
        planId: plan.id,
        seats,
        providerRef: reference,
      });

      return {
        actionUrl: checkout.actionUrl,
        fields: checkout.fields,
        reference: checkout.reference,
        planId: plan.id,
        seats,
      };
    },
  },

  // PayFast has no trustworthy "verify this reference" call, so this simply
  // re-reads the subscription; the browser polls it after returning while the
  // ITN (the real proof of payment) is applied.
  verify: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => subscriptionDetail(ctx.session, ctx.query.id || null),
  },

  cancel: {
    method: 'POST',
    auth: 'session',
    handler: async (ctx) => {
      const context = await loadWorkspaceContext(ctx.session, ctx.query.id || null);
      assertBillingAdmin(ctx.session);
      await upsertSubscription(context.workspace.id, { status: 'canceled' });
      return subscriptionDetail(ctx.session, context.workspace.id);
    },
  },

  // ── Provider webhook (PayFast ITN) ──────────────────────────────────────
  // Authenticated by the PayFast signature, the source IP, and PayFast's own
  // validate endpoint — never by a session token.
  webhook: {
    method: 'POST',
    auth: 'none',
    body: 'none',
    bodyLimit: WEBHOOK_MAX_BYTES,
    handler: async (ctx) => {
      const provider = billingProvider();
      if (!provider.configured) {
        throw new AppError(Codes.VALIDATION_ERROR, 'Billing is not configured on this deployment.', 400);
      }

      const { raw, exact } = await rawBodyBestEffort(ctx.req, { limit: WEBHOOK_MAX_BYTES });
      if (!exact) {
        throw new AppError(
          Codes.SIGNATURE_INVALID,
          'The webhook body could not be read exactly; refusing an unverifiable event.',
          400,
        );
      }

      if (!provider.validateSourceIp(ctx.ip)) {
        throw new AppError(Codes.SIGNATURE_INVALID, 'Webhook did not originate from the provider.', 403);
      }

      // Form-encoded: preserve field order, because the signature depends on it.
      const fields = Object.fromEntries(new URLSearchParams(raw.toString('utf8')).entries());

      if (!provider.verifySignature(fields)) {
        throw new AppError(Codes.SIGNATURE_INVALID, 'Invalid webhook signature.', 401);
      }
      if (!(await provider.confirmNotification(fields))) {
        throw new AppError(Codes.SIGNATURE_INVALID, 'Webhook could not be confirmed with the provider.', 401);
      }

      const event = provider.parseWebhook(fields);
      const eventId = event?.eventId || fields.pf_payment_id || fields.m_payment_id;
      if (!eventId) throw new AppError(Codes.VALIDATION_ERROR, 'Webhook has no event id.', 400);

      const { inserted } = await recordBillingEvent({
        provider: provider.name,
        eventId: String(eventId),
        type: event?.type ?? fields.payment_status ?? null,
        payload: fields,
      });
      if (!inserted) return { received: true, duplicate: true };

      if (!event) return { received: true, applied: false, ignored: fields.payment_status ?? null };

      assertEventAmount(event);
      const result = await applyEvent(event);
      logger.info('Billing event applied', { type: event.type, ...result });
      return { received: true, ...result };
    },
  },
};

export default createHandler({ name: 'billing', actions });
