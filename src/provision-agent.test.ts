/**
 * provisionAgent — the atomic "new agent for this chat" primitive.
 * Asserts every ingredient of the recipe lands (the Worksong incident:
 * partial provisioning produced a mute agent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-provision';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-provision/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-provision/groups',
  };
});

function now() {
  return new Date().toISOString();
}

describe('provisionAgent', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { initTestDb, runMigrations, createMessagingGroup } = await import('./db/index.js');
    const db = initTestDb();
    runMigrations(db);
    createMessagingGroup({
      id: 'mg-chat',
      channel_type: 'whatsapp',
      platform_id: '12345@g.us',
      name: 'Worksong',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('creates ALL six ingredients in one call', async () => {
    const { provisionAgent } = await import('./provision-agent.js');
    const { getAgentGroup, getMessagingGroupAgents } = await import('./db/index.js');
    const { getContainerConfig } = await import('./db/container-configs.js');
    const { getDestinationByTarget } = await import('./modules/agent-to-agent/db/agent-destinations.js');

    const r = provisionAgent({ name: 'Worksong', messagingGroupId: 'mg-chat', purpose: 'brainstorming partner' });

    // agent group + folder slug
    const ag = getAgentGroup(r.agentGroupId);
    expect(ag?.name).toBe('Worksong');
    expect(ag?.folder).toBe('worksong');

    // signing name
    expect(getContainerConfig(r.agentGroupId)?.assistant_name).toBe('Worksong');

    // always-on wiring
    const wirings = getMessagingGroupAgents('mg-chat');
    expect(wirings).toHaveLength(1);
    expect(wirings[0]!.engage_mode).toBe('pattern');
    expect(wirings[0]!.engage_pattern).toBe('.');

    // channel destination back to the home chat
    const dest = getDestinationByTarget(r.agentGroupId, 'channel', 'mg-chat');
    expect(dest).toBeTruthy();

    // persona with the where-to-reply rules, referencing the REAL dest name
    const persona = fs.readFileSync(path.join(TEST_DIR, 'groups', 'worksong', 'CLAUDE.local.md'), 'utf-8');
    expect(persona).toContain('brainstorming partner');
    expect(persona).toContain('Where to reply');
    expect(persona).toContain(`to="${dest!.local_name}"`);
    expect(r.personaCreated).toBe(true);
  });

  it('refuses a chat that already has a wired agent (no duplicates)', async () => {
    const { provisionAgent } = await import('./provision-agent.js');
    provisionAgent({ name: 'First', messagingGroupId: 'mg-chat' });
    expect(() => provisionAgent({ name: 'Second', messagingGroupId: 'mg-chat' })).toThrow(/already has/);
  });

  it('dedupes the folder slug when taken', async () => {
    const { provisionAgent } = await import('./provision-agent.js');
    const { createAgentGroup, createMessagingGroup } = await import('./db/index.js');
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'tester', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'whatsapp',
      platform_id: '777@g.us',
      name: 'Second chat',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    const r = provisionAgent({ name: 'Tester', messagingGroupId: 'mg-2' });
    expect(r.folder).toBe('tester-2');
  });
});

describe('handleDiscoveredGroup', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { initTestDb, runMigrations } = await import('./db/index.js');
    runMigrations(initTestDb());
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('registers an unknown group exactly once (strict, unwired)', async () => {
    const { handleDiscoveredGroup } = await import('./group-onboarding.js');
    const { getMessagingGroupByPlatform, getMessagingGroupAgents } = await import('./db/index.js');

    handleDiscoveredGroup('whatsapp', '999@g.us', 'Fresh Group');
    const mg = getMessagingGroupByPlatform('whatsapp', '999@g.us');
    expect(mg).toBeTruthy();
    expect(mg!.unknown_sender_policy).toBe('strict');
    expect(getMessagingGroupAgents(mg!.id)).toHaveLength(0);

    // Second sighting (every message fires onMetadata) — no duplicate, no churn.
    handleDiscoveredGroup('whatsapp', '999@g.us', 'Fresh Group');
    expect(getMessagingGroupByPlatform('whatsapp', '999@g.us')!.id).toBe(mg!.id);
  });

  it('ignores already-registered groups (the common path is free)', async () => {
    const { handleDiscoveredGroup } = await import('./group-onboarding.js');
    const { createMessagingGroup, getAllMessagingGroups } = await import('./db/index.js');
    createMessagingGroup({
      id: 'mg-known',
      channel_type: 'whatsapp',
      platform_id: 'known@g.us',
      name: 'Known',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    handleDiscoveredGroup('whatsapp', 'known@g.us', 'Known');
    expect(getAllMessagingGroups()).toHaveLength(1);
  });
});
