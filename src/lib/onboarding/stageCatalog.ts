/**
 * Stage catalog — declarative configs for orchestrated onboarding stages.
 *
 * Order matters: stages are evaluated front-to-back by the orchestrator, and
 * the first eligible wins (single-slot invariant).
 */

import type { StageConfig, ToasterId } from './orchestrator';

export const STAGE_ORDER: ToasterId[] = [
  'permissions',
  'browser_extension',
  'profile_intelligence',
  'modes_manager',
];

export const STAGES: StageConfig[] = [
  // ──────────────────────────────────────────────────────────────
  // 1. Permissions — first launch OR returning mac user with revoked TCC
  // ──────────────────────────────────────────────────────────────
  {
    id: 'permissions',
    order: 1,
    onceEver: false, // can re-fire if mac TCC is denied
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 2_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    skipWhen: (s) =>
      // Skip if fully resolved
      (s.permsShown && !s.macTCCBlocked),
    reEligibility: (s) => s.macTCCBlocked,
  },

  // ──────────────────────────────────────────────────────────────
  // 2. Browser extension — gates on permissions + next-launch semantics
  // ──────────────────────────────────────────────────────────────
  {
    id: 'browser_extension',
    order: 2,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 5_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['permissions'],
    skipWhen: (s) =>
      !s.extensionSupported ||
      !s.isV2_8_OrNewer ||
      s.extensionConnected,
    cooldownMs: () => 7 * 24 * 60 * 60 * 1000, // 7 days
  },

  // ──────────────────────────────────────────────────────────────
  // 3. Profile intelligence — after browser ext seen/skipped
  // ──────────────────────────────────────────────────────────────
  {
    id: 'profile_intelligence',
    order: 3,
    onceEver: true,
    isGateOnly: true, // UI is the Launcher's header icon popover, not this stage
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 4_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['browser_extension'],
    skipWhen: (s) =>
      s.hasProfile ||
      s.seenProfileOnboarding,
  },

  // ──────────────────────────────────────────────────────────────
  // 4. Modes manager — after profile seen/skipped
  // ──────────────────────────────────────────────────────────────
  {
    id: 'modes_manager',
    order: 4,
    onceEver: true,
    isGateOnly: true, // UI is the Launcher's header icon popover, not this stage
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 4_000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['profile_intelligence'],
    skipWhen: (s) =>
      s.seenModesOnboarding ||
      s.activeModeSet,
  },
];
