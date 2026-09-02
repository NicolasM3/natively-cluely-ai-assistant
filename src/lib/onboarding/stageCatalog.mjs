/**
 * Stage catalog — .mjs companion to stageCatalog.ts.
 *
 * Stage configurations are pure data + functions, so we can mirror them
 * cleanly in .mjs for `node --test`.
 */

export const STAGE_ORDER = [
  'permissions',
  'browser_extension',
  'profile_intelligence',
  'modes_manager',
];

export const STAGES = [
  {
    id: 'permissions',
    order: 1,
    onceEver: false,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 2000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    skipWhen: (s) => (s.permsShown && !s.macTCCBlocked),
    reEligibility: (s) => s.macTCCBlocked,
  },
  {
    id: 'browser_extension',
    order: 2,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 5000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['permissions'],
    skipWhen: (s) => !s.extensionSupported || !s.isV2_8_OrNewer || s.extensionConnected,
    cooldownMs: () => 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'profile_intelligence',
    order: 3,
    onceEver: true,
    isGateOnly: true,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 4000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['browser_extension'],
    skipWhen: (s) => s.hasProfile || s.seenProfileOnboarding,
  },
  {
    id: 'modes_manager',
    order: 4,
    onceEver: true,
    isGateOnly: true,
    triggers: {
      requiresHomepageMounted: true,
      requiresHomepageDuration: 4000,
      requiresForeground: true,
      requiresMeetingInactive: true,
    },
    requiresStages: ['profile_intelligence'],
    skipWhen: (s) => s.seenModesOnboarding || s.activeModeSet,
  },
];
