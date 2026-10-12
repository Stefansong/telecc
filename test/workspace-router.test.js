import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDir;
let router;

beforeEach(async () => {
  // Create isolated temp directory for all data files
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-router-test-'));

  process.env.SESSION_MAP_PATH = path.join(testDir, 'session-map.json');
  process.env.CCGRAM_DATA_DIR = testDir;
  process.env.DEFAULT_WORKSPACE_PATH = path.join(testDir, 'default-workspace.json');
  process.env.MESSAGE_WORKSPACE_MAP_PATH = path.join(testDir, 'message-workspace-map.json');
  process.env.PROJECT_HISTORY_PATH = path.join(testDir, 'project-history.json');

  // Reset module cache so workspace-router reads new env vars
  vi.resetModules();
  router = await import('../workspace-router.js');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.SESSION_MAP_PATH;
  delete process.env.CCGRAM_DATA_DIR;
  delete process.env.DEFAULT_WORKSPACE_PATH;
  delete process.env.MESSAGE_WORKSPACE_MAP_PATH;
  delete process.env.PROJECT_HISTORY_PATH;
});

describe('extractWorkspaceName', () => {
  it('extracts basename from a path', () => {
    expect(router.extractWorkspaceName('/home/user/projects/my-project')).toBe('my-project');
  });

  it('handles single directory', () => {
    expect(router.extractWorkspaceName('/assistant')).toBe('assistant');
  });

  it('returns null for empty/null input', () => {
    expect(router.extractWorkspaceName(null)).toBeNull();
    expect(router.extractWorkspaceName('')).toBeNull();
  });
});

describe('isExpired', () => {
  it('returns true for expired session', () => {
    const session = { expiresAt: Math.floor(Date.now() / 1000) - 100 };
    expect(router.isExpired(session)).toBe(true);
  });

  it('returns false for valid session', () => {
    const session = { expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    expect(router.isExpired(session)).toBe(false);
  });

  it('returns falsy when no expiresAt', () => {
    expect(router.isExpired({})).toBeFalsy();
  });
});

describe('readSessionMap / writeSessionMap', () => {
  it('returns empty object when no map exists', () => {
    expect(router.readSessionMap()).toEqual({});
  });

  it('roundtrips data', () => {
    const map = { TOKEN1: { cwd: '/foo', createdAt: 100 } };
    router.writeSessionMap(map);
    expect(router.readSessionMap()).toEqual(map);
  });
});

// Helper: write a session map with known entries
function seedSessions(entries) {
  const now = Math.floor(Date.now() / 1000);
  const map = {};
  for (const [token, workspace, opts = {}] of entries) {
    map[token] = {
      type: 'pty',
      createdAt: opts.createdAt || now,
      expiresAt: opts.expired ? now - 100 : now + 86400,
      cwd: `/home/user/projects/${workspace}`,
      tmuxSession: `claude-${workspace}`,
      description: `running - ${workspace}`,
    };
  }
  router.writeSessionMap(map);
}

describe('resolveWorkspace', () => {
  it('returns exact match', () => {
    seedSessions([['T1', 'assistant']]);
    const result = router.resolveWorkspace('assistant');
    expect(result.type).toBe('exact');
    expect(result.workspace).toBe('assistant');
  });

  it('returns exact match case-insensitively', () => {
    seedSessions([['T1', 'Assistant']]);
    const result = router.resolveWorkspace('assistant');
    expect(result.type).toBe('exact');
  });

  it('returns prefix match for unique prefix', () => {
    seedSessions([['T1', 'assistant']]);
    const result = router.resolveWorkspace('ass');
    expect(result.type).toBe('prefix');
    expect(result.workspace).toBe('assistant');
  });

  it('returns ambiguous when prefix matches multiple', () => {
    seedSessions([['T1', 'app-frontend'], ['T2', 'app-backend']]);
    const result = router.resolveWorkspace('app');
    expect(result.type).toBe('ambiguous');
    expect(result.matches).toHaveLength(2);
  });

  it('returns none when nothing matches', () => {
    seedSessions([['T1', 'assistant']]);
    const result = router.resolveWorkspace('zzz');
    expect(result.type).toBe('none');
  });

  it('skips expired sessions', () => {
    seedSessions([['T1', 'assistant', { expired: true }]]);
    const result = router.resolveWorkspace('assistant');
    expect(result.type).toBe('none');
  });
});

describe('findSessionByWorkspace', () => {
  it('finds matching session', () => {
    seedSessions([['T1', 'ccgram']]);
    const result = router.findSessionByWorkspace('ccgram');
    expect(result).not.toBeNull();
    expect(result.token).toBe('T1');
  });

  it('returns most recent when multiple sessions for same workspace', () => {
    const now = Math.floor(Date.now() / 1000);
    seedSessions([
      ['T1', 'ccgram', { createdAt: now - 100 }],
      ['T2', 'ccgram', { createdAt: now }],
    ]);
    const result = router.findSessionByWorkspace('ccgram');
    expect(result.token).toBe('T2');
  });

  it('returns null when not found', () => {
    expect(router.findSessionByWorkspace('nonexistent')).toBeNull();
  });
});

describe('upsertSession', () => {
  it('creates a new session', () => {
    const result = router.upsertSession({
      cwd: '/home/user/projects/test-proj',
      tmuxSession: 'claude-test-proj',
      status: 'running',
    });
    expect(result.workspace).toBe('test-proj');
    expect(result.token).toMatch(/^[A-Z0-9]{8}$/);

    const map = router.readSessionMap();
    expect(Object.keys(map)).toHaveLength(1);
  });

  it('reuses token for same cwd + tmuxSession', () => {
    const first = router.upsertSession({
      cwd: '/home/user/projects/proj',
      tmuxSession: 'claude-proj',
      status: 'running',
    });
    const second = router.upsertSession({
      cwd: '/home/user/projects/proj',
      tmuxSession: 'claude-proj',
      status: 'running',
    });
    expect(second.token).toBe(first.token);

    const map = router.readSessionMap();
    expect(Object.keys(map)).toHaveLength(1);
  });
});

describe('pruneExpired', () => {
  it('removes expired sessions', () => {
    seedSessions([
      ['T1', 'old', { expired: true }],
      ['T2', 'new'],
    ]);
    const pruned = router.pruneExpired();
    expect(pruned).toBe(1);

    const map = router.readSessionMap();
    expect(map['T1']).toBeUndefined();
    expect(map['T2']).toBeDefined();
  });

  it('returns 0 when nothing to prune', () => {
    seedSessions([['T1', 'active']]);
    expect(router.pruneExpired()).toBe(0);
  });
});

describe('listActiveSessions', () => {
  it('lists non-expired sessions deduplicated by workspace', () => {
    const now = Math.floor(Date.now() / 1000);
    seedSessions([
      ['T1', 'proj', { createdAt: now - 100 }],
      ['T2', 'proj', { createdAt: now }],
      ['T3', 'other'],
    ]);
    const sessions = router.listActiveSessions();
    expect(sessions).toHaveLength(2);
    // Should pick newest session for 'proj'
    const proj = sessions.find(s => s.workspace === 'proj');
    expect(proj.token).toBe('T2');
  });
});

describe('default workspace', () => {
  it('returns null when no default set', () => {
    expect(router.getDefaultWorkspace()).toBeNull();
  });

  it('roundtrips set/get', () => {
    router.setDefaultWorkspace('assistant');
    expect(router.getDefaultWorkspace()).toBe('assistant');
  });

  it('clears when set to null', () => {
    router.setDefaultWorkspace('assistant');
    router.setDefaultWorkspace(null);
    expect(router.getDefaultWorkspace()).toBeNull();
  });
});

describe('message-to-workspace tracking', () => {
  it('tracks and retrieves message workspace', () => {
    router.trackNotificationMessage(12345, 'assistant', 'permission');
    expect(router.getWorkspaceForMessage(12345)).toBe('assistant');
  });

  it('returns null for unknown message', () => {
    expect(router.getWorkspaceForMessage(99999)).toBeNull();
  });

  it('returns null for null/undefined messageId', () => {
    expect(router.getWorkspaceForMessage(null)).toBeNull();
    expect(router.getWorkspaceForMessage(undefined)).toBeNull();
  });
});

describe('recordProjectUsage with sessionId', () => {
  it('stores session in sessions[] when sessionId provided', () => {
    router.recordProjectUsage('myproject', testDir, 'session-uuid-1');
    const history = JSON.parse(fs.readFileSync(path.join(testDir, 'project-history.json'), 'utf8'));
    expect(history['myproject'].sessions).toHaveLength(1);
    expect(history['myproject'].sessions[0].id).toBe('session-uuid-1');
  });

  it('preserves existing sessions when called without sessionId', () => {
    router.recordProjectUsage('myproject', testDir, 'session-uuid-1');
    router.recordProjectUsage('myproject', testDir);
    const history = JSON.parse(fs.readFileSync(path.join(testDir, 'project-history.json'), 'utf8'));
    expect(history['myproject'].sessions).toHaveLength(1);
    expect(history['myproject'].sessions[0].id).toBe('session-uuid-1');
  });

  it('deduplicates: same sessionId not added twice', () => {
    router.recordProjectUsage('myproject', testDir, 'session-uuid-1');
    router.recordProjectUsage('myproject', testDir, 'session-uuid-1');
    const history = JSON.parse(fs.readFileSync(path.join(testDir, 'project-history.json'), 'utf8'));
    expect(history['myproject'].sessions).toHaveLength(1);
  });

  it('newest session is always at index 0', () => {
    router.recordProjectUsage('myproject', testDir, 'uuid-old');
    router.recordProjectUsage('myproject', testDir, 'uuid-new');
    const history = JSON.parse(fs.readFileSync(path.join(testDir, 'project-history.json'), 'utf8'));
    expect(history['myproject'].sessions[0].id).toBe('uuid-new');
  });

  it('caps at 5: oldest session dropped when 6th added', () => {
    for (let i = 1; i <= 6; i++) {
      router.recordProjectUsage('myproject', testDir, `uuid-${i}`);
    }
    const history = JSON.parse(fs.readFileSync(path.join(testDir, 'project-history.json'), 'utf8'));
    expect(history['myproject'].sessions).toHaveLength(5);
    expect(history['myproject'].sessions[0].id).toBe('uuid-6');
    expect(history['myproject'].sessions.find(s => s.id === 'uuid-1')).toBeUndefined();
  });
});

describe('getResumeableProjects', () => {
  it('excludes projects with no sessions array', () => {
    router.recordProjectUsage('no-sessions', testDir);
    const result = router.getResumeableProjects();
    expect(result.find(p => p.name === 'no-sessions')).toBeUndefined();
  });

  it('returns projects that have session IDs', () => {
    router.recordProjectUsage('with-sessions', testDir, 'some-uuid');
    const result = router.getResumeableProjects();
    expect(result.find(p => p.name === 'with-sessions')).toBeDefined();
  });

  it('returns projects sorted by lastUsed descending', async () => {
    router.recordProjectUsage('proj-a', testDir, 'uuid-a');
    await new Promise(r => setTimeout(r, 5));
    router.recordProjectUsage('proj-b', testDir, 'uuid-b');
    const result = router.getResumeableProjects();
    const names = result.map(p => p.name);
    expect(names.indexOf('proj-b')).toBeLessThan(names.indexOf('proj-a'));
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      router.recordProjectUsage(`proj-${i}`, testDir, `uuid-${i}`);
    }
    const result = router.getResumeableProjects(3);
    expect(result).toHaveLength(3);
  });

  it('excludes projects whose path does not exist on disk', () => {
    router.recordProjectUsage('ghost-project', '/nonexistent/path/ghost', 'some-uuid');
    const result = router.getResumeableProjects();
    expect(result.find(p => p.name === 'ghost-project')).toBeUndefined();
  });
});

describe('rate limit tracking', () => {
  beforeEach(() => {
    router.writeSessionMap({});
  });

  it('stores rate limit info via upsertSession', () => {
    const rateLimit = {
      remaining: 50,
      limit: 100,
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      updatedAt: Date.now(),
    };
    router.upsertSession({
      cwd: testDir,
      tmuxSession: 'test-session',
      status: 'completed',
      sessionId: 'test-id',
      rateLimit,
    });

    const result = router.getSessionRateLimit(path.basename(testDir));
    expect(result).toBeDefined();
    expect(result.remaining).toBe(50);
    expect(result.limit).toBe(100);
  });

  it('updates rate limit for existing session', () => {
    router.upsertSession({
      cwd: testDir,
      tmuxSession: 'test-session',
      status: 'completed',
      sessionId: 'test-id',
    });

    const rateLimit = {
      remaining: 25,
      limit: 100,
      updatedAt: Date.now(),
    };
    const updated = router.updateSessionRateLimit(path.basename(testDir), rateLimit);
    expect(updated).toBe(true);

    const result = router.getSessionRateLimit(path.basename(testDir));
    expect(result).toBeDefined();
    expect(result.remaining).toBe(25);
  });

  it('returns false when updating non-existent session', () => {
    const rateLimit = { remaining: 10, limit: 100, updatedAt: Date.now() };
    const updated = router.updateSessionRateLimit('nonexistent', rateLimit);
    expect(updated).toBe(false);
  });

  it('returns undefined for session without rate limit', () => {
    router.upsertSession({
      cwd: testDir,
      tmuxSession: 'test-session',
      status: 'completed',
      sessionId: 'test-id',
    });

    const result = router.getSessionRateLimit(path.basename(testDir));
    expect(result).toBeUndefined();
  });

  it('preserves rate limit on upsert without new rateLimit param', () => {
    const rateLimit = { remaining: 50, limit: 100, updatedAt: Date.now() };
    router.upsertSession({
      cwd: testDir,
      tmuxSession: 'test-session',
      status: 'completed',
      rateLimit,
    });

    // Upsert again without rateLimit
    router.upsertSession({
      cwd: testDir,
      tmuxSession: 'test-session',
      status: 'waiting',
    });

    const result = router.getSessionRateLimit(path.basename(testDir));
    expect(result).toBeDefined();
    expect(result.remaining).toBe(50);
  });
});

describe('resolveWorkspace allowPrefix option', () => {
  it('defaults to allowing prefix matches', () => {
    seedSessions([['T1', 'api-server']]);
    expect(router.resolveWorkspace('api').type).toBe('prefix');
    expect(router.resolveWorkspace('api', {}).type).toBe('prefix');
  });

  it('allowPrefix: false only returns exact (case-insensitive) matches', () => {
    seedSessions([['T1', 'api-server'], ['T2', 'API']]);
    const exact = router.resolveWorkspace('api', { allowPrefix: false });
    expect(exact.type).toBe('exact');
    expect(exact.match.token).toBe('T2');

    seedSessions([['T1', 'api-server']]);
    expect(router.resolveWorkspace('api', { allowPrefix: false }).type).toBe('none');
    expect(router.resolveWorkspace('API-SERVER', { allowPrefix: false }).type).toBe('exact');
  });

  it('allowPrefix: false never reports ambiguity', () => {
    seedSessions([['T1', 'app-frontend'], ['T2', 'app-backend']]);
    expect(router.resolveWorkspace('app', { allowPrefix: false }).type).toBe('none');
  });
});

describe('ended sessions (markSessionEnded / endedAt)', () => {
  it('markSessionEnded ends only the exiting session (by pane, then session id)', () => {
    seedSessions([['T1', 'proj'], ['T2', 'other']]);
    const map = router.readSessionMap();
    map['T1'] = { ...map['T1'], tmuxPane: '%1', sessionId: 'sid-1' };
    map['T3'] = { ...map['T1'], tmuxSession: 'claude-proj-2', tmuxPane: '%3', sessionId: 'sid-3' };
    router.writeSessionMap(map);

    const before = Math.floor(Date.now() / 1000);
    router.markSessionEnded('/home/user/projects/proj/', { tmuxPane: '%3' }); // trailing slash normalised
    let after = router.readSessionMap();
    expect(after['T3'].endedAt).toBeGreaterThanOrEqual(before);
    expect(after['T1'].endedAt).toBeUndefined();

    router.markSessionEnded('/home/user/projects/proj', { sessionId: 'sid-1' });
    after = router.readSessionMap();
    expect(after['T1'].endedAt).toBeGreaterThanOrEqual(before);
    expect(after['T2'].endedAt).toBeUndefined();
  });

  it('markSessionEnded without ids only ends an unambiguous cwd match', () => {
    seedSessions([['T1', 'proj'], ['T2', 'other']]);
    const map = router.readSessionMap();
    map['T3'] = { ...map['T1'], tmuxSession: 'claude-proj-2' };
    router.writeSessionMap(map);
    router.markSessionEnded('/home/user/projects/proj');
    expect(router.readSessionMap()['T1'].endedAt).toBeUndefined();
    router.markSessionEnded('/home/user/projects/other');
    expect(router.readSessionMap()['T2'].endedAt).toBeDefined();
  });

  it('ended sessions are skipped by every routing lookup', () => {
    seedSessions([['T1', 'proj'], ['T2', 'other']]);
    router.markSessionEnded('/home/user/projects/proj');

    expect(router.resolveWorkspace('proj').type).toBe('none');
    expect(router.resolveWorkspace('pro').type).toBe('none');
    expect(router.findSessionByWorkspace('proj')).toBeNull();
    expect(router.findSessionByTmuxName('claude-proj')).toBeUndefined();
    expect(router.listActiveSessions().map(s => s.workspace)).toEqual(['other']);
    expect(router.isEnded(router.readSessionMap()['T1'])).toBe(true);
  });

  it('an ended newer entry does not shadow an older live one', () => {
    const now = Math.floor(Date.now() / 1000);
    seedSessions([['OLD', 'proj', { createdAt: now - 100 }]]);
    const map = router.readSessionMap();
    map['NEW'] = { ...map['OLD'], createdAt: now, tmuxSession: 'claude-proj-new', endedAt: now };
    router.writeSessionMap(map);
    expect(router.findSessionByWorkspace('proj').token).toBe('OLD');
    expect(router.resolveWorkspace('proj').match.token).toBe('OLD');
  });

  it('upsertSession revives an ended session (clears endedAt, keeps token)', () => {
    const first = router.upsertSession({ cwd: '/home/user/projects/proj', tmuxSession: 'claude-proj', status: 'running', sessionType: 'pty' });
    router.markSessionEnded('/home/user/projects/proj');
    expect(router.readSessionMap()[first.token].endedAt).toBeDefined();

    const second = router.upsertSession({ cwd: '/home/user/projects/proj', tmuxSession: 'claude-proj', status: 'running' });
    expect(second.token).toBe(first.token);
    expect(router.readSessionMap()[first.token].endedAt).toBeUndefined();
    expect(router.findSessionByWorkspace('proj').token).toBe(first.token);
  });

  it('markSessionEnded on an unknown cwd leaves the map untouched', () => {
    seedSessions([['T1', 'proj']]);
    const before = fs.readFileSync(process.env.SESSION_MAP_PATH, 'utf8');
    router.markSessionEnded('/nowhere');
    expect(fs.readFileSync(process.env.SESSION_MAP_PATH, 'utf8')).toBe(before);
  });
});

describe('upsertSession tmuxPane', () => {
  const base = { cwd: '/home/user/projects/proj', tmuxSession: 'claude-proj', status: 'running' };

  it('stores the pane id', () => {
    const { token } = router.upsertSession({ ...base, tmuxPane: '%12' });
    expect(router.readSessionMap()[token].tmuxPane).toBe('%12');
  });

  it('preserves the existing pane when not given and replaces it when given', () => {
    const { token } = router.upsertSession({ ...base, tmuxPane: '%12' });
    router.upsertSession({ ...base, status: 'waiting' });
    expect(router.readSessionMap()[token].tmuxPane).toBe('%12');
    router.upsertSession({ ...base, tmuxPane: '%40' });
    expect(router.readSessionMap()[token].tmuxPane).toBe('%40');
  });

  it('omits tmuxPane entirely when never known', () => {
    const { token } = router.upsertSession(base);
    expect('tmuxPane' in router.readSessionMap()[token]).toBe(false);
  });
});

describe('findSessionByTmuxName exact matching', () => {
  it('does not prefix-match tmux session names', () => {
    seedSessions([['T1', 'api-server']]); // tmuxSession: claude-api-server
    expect(router.findSessionByTmuxName('claude-api')).toBeUndefined();
    expect(router.findSessionByTmuxName('claude-api-server')).toBeDefined();
    expect(router.findSessionByTmuxName('')).toBeUndefined();
  });
});

describe('state file safety', () => {
  it('writes atomically (no temp files left behind)', () => {
    router.upsertSession({ cwd: '/home/user/projects/proj', tmuxSession: 'claude-proj', status: 'running' });
    router.trackNotificationMessage(1, 'proj', 'completed');
    router.setDefaultWorkspace('proj');
    const leftovers = fs.readdirSync(testDir).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('never silently replaces a corrupt session map with an empty one', () => {
    const corrupt = '{"T1": {"cwd": "/home/user/projects/keep", ';
    fs.writeFileSync(process.env.SESSION_MAP_PATH, corrupt);
    router.upsertSession({ cwd: '/home/user/projects/new', tmuxSession: 'claude-new', status: 'running' });
    // The unparseable original is preserved next to the map for recovery
    const aside = fs.readdirSync(testDir).filter(f => f.startsWith('session-map.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(testDir, aside[0]), 'utf8')).toBe(corrupt);
  });

  it('does not overwrite project history when it cannot be read', () => {
    const historyPath = path.join(testDir, 'project-history.json');
    fs.mkdirSync(historyPath); // reading a directory fails with EISDIR (not ENOENT)
    expect(() => router.recordProjectUsage('proj', testDir, 'uuid')).not.toThrow();
    expect(fs.statSync(historyPath).isDirectory()).toBe(true);
  });

  it('tolerates non-object JSON in the session map', () => {
    fs.writeFileSync(process.env.SESSION_MAP_PATH, 'null');
    expect(router.readSessionMap()).toEqual({});
    expect(router.listActiveSessions()).toEqual([]);
  });
});
