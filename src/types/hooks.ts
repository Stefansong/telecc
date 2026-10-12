/**
 * Claude Code hook stdin payload types.
 */

export interface HookStdinBase {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
}

export interface ToolInputBash {
  command: string;
  description?: string;
  timeout?: number;
}

export interface ToolInputEdit {
  file_path: string;
  old_string?: string;
  new_string?: string;
}

export interface ToolInputWrite {
  file_path: string;
  content: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface ToolInputAskUser {
  questions: AskUserQuestionItem[];
}

/**
 * Permission update entry — used by both PermissionRequest input `permission_suggestions`
 * and decision output `updatedPermissions` (Claude Code hooks reference, "Permission
 * update entries"). `destination`: session | localSettings | projectSettings | userSettings.
 */
export interface PermissionUpdateEntry {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories';
  destination: 'session' | 'localSettings' | 'projectSettings' | 'userSettings';
  rules?: Array<{ toolName: string; ruleContent?: string }>;
  behavior?: 'allow' | 'deny' | 'ask';
  mode?: string;
  directories?: string[];
}

export interface PermissionRequestStdin extends HookStdinBase {
  permission_mode?: string;
  /** Optional; the permission updates Claude Code suggests for this request. */
  permission_suggestions?: PermissionUpdateEntry[];
}

export interface PermissionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
      /** allow only: replaces the tool input */
      updatedInput?: Record<string, unknown>;
      /** allow only: permission updates to apply (e.g. echo of permission_suggestions) */
      updatedPermissions?: PermissionUpdateEntry[];
      /** deny only: tells Claude why */
      message?: string;
      /** deny only: true stops Claude */
      interrupt?: boolean;
    };
  };
  systemMessage?: string;
}
