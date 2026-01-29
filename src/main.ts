import "./style.css";
import { invoke } from "@tauri-apps/api/core";

/**
 * gitshlc Frontend (Tauri v2 + Vite + TS)
 * - Home: SSH / LOCAL 選択
 * - Workspace: Projects + pull/push/merge
 * - Settings: 右下固定パネル（×で閉じる）
 * - Detect: local repos 自動検出（Rust command: detect_local_repos）
 * - GitHub: PATで /user/repos を閲覧し repoUrl に流し込み
 */

type Screen = "home" | "workspace";
type Mode = "ssh" | "local";
type EnvKey = "test" | "deploy";
type ActionOp = "pull" | "push" | "merge";

type ToolPaths = {
  gitPath: string;
  sshPath: string;
};

type SshConfig = {
  host: string;
  user: string;
  port: number;
  keyPath: string;
};

type GitHubConfig = {
  username: string;
  token: string; // PAT
};

type ProjectEnv = {
  repoUrl: string;
  branch: string;
  localPath: string;
  remotePath: string;
};

type Project = {
  id: string;
  name: string;
  test: ProjectEnv;
  deploy: ProjectEnv;
};

type AppConfig = {
  toolPaths: ToolPaths;
  ssh: SshConfig;
  github: GitHubConfig;
  projects: Project[];
};

type UiState = {
  screen: Screen;
  mode: Mode;
  drawerOpen: boolean;
  pinnedProjectIds: string[]; // max 12
  selectedEnvByProject: Record<string, EnvKey>;
  selectedProjectId: string | null;
};

type PreflightTool = {
  ok: boolean;
  version?: string | null;
  path?: string | null;
};

type PreflightResultWire = {
  platform: string;
  git: PreflightTool;
  ssh: PreflightTool;
};

type ToolCheckWire = {
  found: boolean;
  path?: string | null;
  version?: string | null;
  ok: boolean;
  error?: string | null;
};

type SshConnectResultWire = {
  ok: boolean; // ready (ssh + remote git)
  sshOk: boolean;
  stderr?: string | null;
  remoteGit: ToolCheckWire;
};


type BranchListWire = {
  ok: boolean;
  branches: string[];
  stderr?: string | null;
};

type DetectRepoWire = {
  path: string;
  originUrl?: string | null;
  name?: string | null;
};

type StepResultWire = {
  ok: boolean;
  cmd: string;
  cwd?: string | null;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
};

type ActionErrorWire = {
  severity: string;
  code: string;
  message: string;
  detail?: unknown;
};

type ActionOutcomeWire = {
  ok: boolean;
  envKey?: string | null;
  action?: string | null;
  steps?: StepResultWire[] | null;
  error?: ActionErrorWire | null;
};


type GitHubRepo = {
  id: number;
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  updatedAt: string;
  stargazersCount: number;
  isPrivate: boolean;
};

type DetectRepoResultWire = {
  path: string;
  name?: string | null;
  hasRemote?: boolean;
  remoteUrl?: string | null;
};

type DetectReposResultWire = {
  repos: DetectRepoResultWire[];
};

type GitHubTarget =
  | { kind: "add"; envKey: EnvKey }
  | { kind: "edit"; projectId: string; envKey: EnvKey }
  | null;

type EditingProjectState = {
  projectId: string | null; // null = add
  draft: Project;
  branchOptions: { test: string[]; deploy: string[] };
  branchLoading: { test: boolean; deploy: boolean };
};

type ToastState = {
  text: string;
  until: number;
};

type AppState = {
  config: AppConfig;
  ui: UiState;

  toast?: ToastState;

  // Settings / tools
  settingsOpen: boolean;

  preflightRunning: boolean;
  preflight?: PreflightResultWire;
  preflightError?: string;

  sshConnectRunning: boolean;
  sshConnectResult?: SshConnectResultWire;

  // Modals
  addProjectOpen: boolean;

  projectSettingsOpen: boolean;
  editingProject?: EditingProjectState;

  detectOpen: boolean;
  detectRootPath: string;
  detectMaxDepth: number;
  detectRunning: boolean;
  detectResults: DetectRepoWire[];
  detectSelected: Record<string, boolean>;
  detectError?: string;

  githubOpen: boolean;
  githubLoading: boolean;
  githubRepos: GitHubRepo[];
  githubTarget: GitHubTarget | null;
  githubError?: string;

  actionOpen: boolean;
  actionRunning: boolean;
  actionTitle: string;
  actionOutcome?: ActionOutcomeWire;
  actionError?: string;

  // Push requires commit message
  commitOpen: boolean;
  commitProjectId: string | null;
  commitMessage: string;
};

const CONFIG_KEY = "gitshlc.config.v1";
const UI_KEY = "gitshlc.ui.v1";
const PIN_LIMIT = 8;

// First paint uses last-known config/ui, then we bootstrap async.
const state: AppState = {
  config: loadConfig(),
  ui: loadUiState(),

  settingsOpen: false,

  preflightRunning: false,
  preflight: undefined,
  preflightError: undefined,

  sshConnectRunning: false,
  sshConnectResult: undefined,

  addProjectOpen: false,

  projectSettingsOpen: false,
  editingProject: undefined,

  detectOpen: false,
  detectRootPath: "",
  detectMaxDepth: 6,
  detectRunning: false,
  detectResults: [],
  detectSelected: {},
  detectError: undefined,

  githubOpen: false,
  githubLoading: false,
  githubRepos: [],
  githubTarget: null,
  githubError: undefined,

  actionOpen: false,
  actionRunning: false,
  actionTitle: "",
  actionOutcome: undefined,
  actionError: undefined,

  commitOpen: false,
  commitProjectId: null,
  commitMessage: "",
};


bootstrap();

function bootstrap(): void {
  // 初期画面整合
  if (state.ui.screen !== "home" && state.ui.screen !== "workspace") {
    state.ui.screen = "home";
  }
  if (state.ui.mode !== "ssh" && state.ui.mode !== "local") {
    state.ui.mode = "ssh";
  }

  // pinned の上限を矯正
  state.ui.pinnedProjectIds = uniqueKeepOrder(state.ui.pinnedProjectIds).slice(0, 12);

  // pinnedに存在しないIDを排除
  const existIds = new Set(state.config.projects.map((p) => p.id));
  state.ui.pinnedProjectIds = state.ui.pinnedProjectIds.filter((id) => existIds.has(id));

  // selectedProjectId 矯正
  if (state.ui.selectedProjectId && !existIds.has(state.ui.selectedProjectId)) {
    state.ui.selectedProjectId = null;
  }

  // detect rootPath 初期値（localの場合だけ、空ならユーザに任せる）
  state.detectRootPath = state.detectRootPath || "";

  render();

  // Tauri環境なら軽くpreflight（失敗してもUIは壊さない）
  if (isTauri()) {
    void runPreflight();
  }
}

function defaultConfig(): AppConfig {
  return {
    toolPaths: { gitPath: "", sshPath: "" },
    ssh: { host: "", user: "", port: 22, keyPath: "" },
    github: { username: "", token: "" },
    projects: [],
  };
}

function defaultProject(): Project {
  return {
    id: makeId(),
    name: "",
    test: { repoUrl: "", branch: "main", localPath: "", remotePath: "" },
    deploy: { repoUrl: "", branch: "main", localPath: "", remotePath: "" },
  };
}

function defaultUiState(): UiState {
  return {
    screen: "home",
    mode: "ssh",
    drawerOpen: true,
    pinnedProjectIds: [],
    selectedEnvByProject: {},
    selectedProjectId: null,
  };
}

function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw) as any;
    return migrateConfig(parsed);
  } catch {
    return defaultConfig();
  }
}

function saveConfig(): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
}

function loadUiState(): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return defaultUiState();
    const parsed = JSON.parse(raw) as any;
    return migrateUi(parsed);
  } catch {
    return defaultUiState();
  }
}

function saveUiState(): void {
  localStorage.setItem(UI_KEY, JSON.stringify(state.ui));
}

function migrateConfig(x: any): AppConfig {
  const cfg = defaultConfig();

  if (x?.toolPaths) {
    cfg.toolPaths.gitPath = String(x.toolPaths.gitPath ?? "");
    cfg.toolPaths.sshPath = String(x.toolPaths.sshPath ?? "");
  }

  if (x?.ssh) {
    cfg.ssh.host = String(x.ssh.host ?? "");
    cfg.ssh.user = String(x.ssh.user ?? "");
    cfg.ssh.port = clampInt(Number(x.ssh.port ?? 22), 1, 65535, 22);
    cfg.ssh.keyPath = String(x.ssh.keyPath ?? "");
  }

  if (x?.github) {
    cfg.github.username = String(x.github.username ?? "");
    cfg.github.token = String(x.github.token ?? "");
  }

  const projectsRaw = Array.isArray(x?.projects) ? x.projects : [];
  cfg.projects = projectsRaw
    .map((p: any) => migrateProject(p))
    .filter((p: Project | null): p is Project => !!p);

  return cfg;
}

function migrateProject(p: any): Project | null {
  if (!p) return null;

  // 旧schema: envs.test / envs.deploy の可能性
  const envs = p.envs ?? null;

  const proj: Project = {
    id: String(p.id ?? makeId()),
    name: String(p.name ?? ""),
    test: migrateProjectEnv(envs?.test ?? p.test ?? null),
    deploy: migrateProjectEnv(envs?.deploy ?? p.deploy ?? null),
  };

  // 空branchを救済
  if (!proj.test.branch.trim()) proj.test.branch = "main";
  if (!proj.deploy.branch.trim()) proj.deploy.branch = "main";

  return proj;
}

function migrateProjectEnv(e: any): ProjectEnv {
  return {
    repoUrl: String(e?.repoUrl ?? ""),
    branch: String(e?.branch ?? ""),
    localPath: String(e?.localPath ?? ""),
    remotePath: String(e?.remotePath ?? ""),
  };
}

function migrateUi(x: any): UiState {
  const ui = defaultUiState();

  ui.screen = x?.screen === "workspace" ? "workspace" : "home";
  ui.mode = x?.mode === "local" ? "local" : "ssh";
  ui.drawerOpen = Boolean(x?.drawerOpen ?? true);

  const pinned: string[] = Array.isArray(x?.pinnedProjectIds) ? x.pinnedProjectIds : Array.isArray(x?.lastOpenProjectIds) ? x.lastOpenProjectIds : [];
  ui.pinnedProjectIds = uniqueKeepOrder(pinned.map((v) => String(v))).slice(0, 12);

  ui.selectedEnvByProject = typeof x?.selectedEnvByProject === "object" && x.selectedEnvByProject
    ? x.selectedEnvByProject
    : typeof x?.selectedEnvKeyByProject === "object" && x.selectedEnvKeyByProject
      ? x.selectedEnvKeyByProject
      : {};

  ui.selectedProjectId = x?.selectedProjectId ? String(x.selectedProjectId) : null;

  return ui;
}

function render(): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;

  const content = state.ui.screen === "home" ? renderHome() : renderWorkspace();

  root.innerHTML = `
    ${content}
    ${renderSettingsFab()}
    ${renderSettingsPanel()}
    ${renderAddProjectModal()}
${renderProjectSettingsModal()}
${renderDetectModal()}
${renderGitHubModal()}
${renderCommitModal()}
${renderActionModal()}
${renderToast()}

  `;

  bindHandlers();
}

function renderHome(): string {
  const pf = state.preflight;
  const pfText = pf
    ? `platform: ${escapeHtml(pf.platform)} / git: ${pf.git.ok ? "OK" : "NG"} / ssh: ${pf.ssh.ok ? "OK" : "NG"}`
    : state.preflightRunning
      ? "preflight: running..."
      : state.preflightError
        ? `preflight: ${escapeHtml(state.preflightError)}`
        : "preflight: --";

  return `
    <div class="homeWrap">
      <div class="homeCard">
        <div class="homeTitleRow">
          <div class="homeTitle">gitshlc</div>
          <div class="homeSub">${pfText}</div>
        </div>

        <div class="homeButtons">
          <button class="btn big" id="btnHomeSsh">SSH</button>
          <button class="btn big" id="btnHomeLocal">LOCAL</button>
        </div>

        <div class="homeFooter">
          <button class="btn ghost" id="btnHomeExit">終了</button>
        </div>
      </div>
    </div>
  `;
}

function renderWorkspace(): string {
  const modeLabel = state.ui.mode === "ssh" ? "SSH" : "LOCAL";
  const sshPill = state.ui.mode === "ssh"
    ? `<div class="pill ${state.sshConnectResult?.ok ? "ok" : "warn"}">
         <span class="pillDot ${state.sshConnectResult?.ok ? "good" : "warn"}"></span>
         SSH: ${state.sshConnectResult?.ok ? "OK" : "NG"}
       </div>`
    : "";

  return `
    <div class="layout ${state.ui.drawerOpen ? "" : "drawerCollapsed"}">
      <aside class="drawer ${state.ui.drawerOpen ? "" : "collapsed"}">
        <div class="drawerTop">
          <div class="drawerTitle">Projects</div>
          <div class="drawerActions">
            <button class="btn ghost" id="btnAddProject">+ Add</button>
            <button class="btn ghost" id="btnDetectRepos">Detect</button>
            <button class="btn ghost" id="btnDrawerToggle">${state.ui.drawerOpen ? "<<" : ">>"}</button>
          </div>
        </div>

        <div class="drawerList">
        ${visibleProjects().map((p) => renderDrawerItem(p)).join("")}

        </div>
      </aside>

      <main class="main">
        <div class="topbar">
          <div class="topbarLeft">
            <button class="btn ghost" id="btnGoHome">←</button>
            <div class="appTitle">gitshlc</div>
            <div class="pill"><span class="pillDot"></span>${modeLabel}</div>
            ${sshPill}
          </div>
          <div class="topbarRight">
            ${state.ui.mode === "ssh"
      ? `<button class="btn" id="btnSshConnectTop"${state.sshConnectRunning ? " disabled" : ""}>
                   ${state.sshConnectRunning ? "Connecting..." : "Connect"}
                 </button>`
      : ""
    }
          </div>
        </div>

        <div class="cards">
          ${renderCards()}
        </div>
      </main>
    </div>
  `;
}

function renderDrawerItem(p: Project): string {
  const pinned = state.ui.pinnedProjectIds.includes(p.id);
  const active = state.ui.selectedProjectId === p.id;
  const envKey = selectedEnvKeyForProject(p.id);
  const env = envKey === "deploy" ? p.deploy : p.test;
  const meta = env.branch ? `branch: ${env.branch}` : "";

  return `
    <button class="drawerItem ${active ? "active" : ""}" data-project-id="${escapeAttr(p.id)}">
      <div class="drawerItemName">${escapeHtml(p.name || "(no name)")}</div>
      <div class="drawerItemMeta">${escapeHtml(meta)}${pinned ? " · pinned" : ""}</div>
    </button>
  `;
}

function renderCards(): string {
  const pinned = pinnedProjects();
  if (pinned.length === 0) {
    return `
      <div class="card">
        <div class="cardHeader">
          <div>
            <div class="cardTitle">No pinned projects</div>
            <div class="cardSub">左のProjectsから選択してピン留めしてください。</div>
          </div>
        </div>
        <div class="muted" style="margin-top:10px;">
          Detectで自動検出 → 追加 → ピン留め、の流れもOKです。
        </div>
      </div>
    `;
  }

  return pinned.map((p) => renderProjectCard(p)).join("");
}

function renderProjectCard(p: Project): string {
  const selected = state.ui.selectedProjectId === p.id;
  const envKey = selectedEnvKeyForProject(p.id);
  const env = envKey === "deploy" ? p.deploy : p.test;
  const pinned = state.ui.pinnedProjectIds.includes(p.id);
  const disabled = state.actionRunning ? " disabled" : "";

  const repoHint = env.repoUrl ? shorten(env.repoUrl) : "(repoUrl未設定)";

  return `
    <div class="card ${selected ? "selected" : ""}" data-card-project-id="${escapeAttr(p.id)}">
      <div class="cardHeader">
        <div>
          <div class="cardTitle">${escapeHtml(p.name || "(no name)")}</div>
          <div class="cardSub">${escapeHtml(repoHint)}</div>
        </div>
        <div class="btnRow">
          <button class="btn ghost" data-pin-project="${escapeAttr(p.id)}">${pinned ? "Unpin" : "Pin"}</button>
          <button class="btn ghost" data-open-project-settings="${escapeAttr(p.id)}">Settings</button>
        </div>
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="seg">
          <button class="btn ${envKey === "test" ? "primary" : "ghost"}" data-select-env="${escapeAttr(p.id)}:test">test</button>
          <button class="btn ${envKey === "deploy" ? "primary" : "ghost"}" data-select-env="${escapeAttr(p.id)}:deploy">deploy</button>
        </div>
        <div class="pill">branch: <b>${escapeHtml(env.branch || "")}</b></div>
      </div>

      <div class="row actions" style="margin-top:12px;">
        <button class="btn" data-action="${escapeAttr(p.id)}:pull"${disabled}>pull</button>
        <button class="btn" data-action="${escapeAttr(p.id)}:push"${disabled}>push</button>
        <button class="btn" data-action="${escapeAttr(p.id)}:merge"${disabled}>merge</button>
      </div>
    </div>
  `;
}

function renderSettingsFab(): string {
  return `
    <button class="fab" id="btnSettingsFab" aria-label="settings">⚙</button>
  `;
}

function renderSettingsPanel(): string {
  if (!state.settingsOpen) return "";

  const pf = state.preflight;

  return `
    <div class="settingsPanel" role="dialog" aria-label="settings">
      <div class="settingsTop">
        <div class="settingsTitle">Settings</div>
        <button class="btn ghost" id="btnSettingsClose" aria-label="close">×</button>
      </div>

      <div class="settingsBody">
        <div class="section">
          <div class="sectionTitle">Tools</div>

          <label class="field">
            <div class="label">gitPath</div>
            <input class="input" id="inpGitPath" value="${escapeAttr(state.config.toolPaths.gitPath)}" placeholder="(optional) ex: C:\\Program Files\\Git\\cmd\\git.exe"/>
          </label>

          <label class="field">
            <div class="label">sshPath</div>
            <input class="input" id="inpSshPath" value="${escapeAttr(state.config.toolPaths.sshPath)}" placeholder="(optional) ex: C:\\Windows\\System32\\OpenSSH\\ssh.exe"/>
          </label>

          <div class="row right">
            <button class="btn" id="btnRunPreflight"${state.preflightRunning ? " disabled" : ""}>
              ${state.preflightRunning ? "Running..." : "Preflight"}
            </button>
          </div>

          ${pf ? `
            <div class="miniBox">
              <div>platform: ${escapeHtml(pf.platform)}</div>
              <div>git: ${pf.git.ok ? "OK" : "NG"} ${escapeHtml(String(pf.git.version ?? ""))}</div>
              <div>ssh: ${pf.ssh.ok ? "OK" : "NG"} ${escapeHtml(String(pf.ssh.version ?? ""))}</div>
            </div>
          ` : ""}

          ${state.preflightError ? `<div class="errorBox">${escapeHtml(state.preflightError)}</div>` : ""}
        </div>

        <div class="section">
          <div class="sectionTitle">VPS (SSH)</div>

          <label class="field">
            <div class="label">host</div>
            <input class="input" id="inpSshHost" value="${escapeAttr(state.config.ssh.host)}" placeholder="example.com"/>
          </label>

          <label class="field">
            <div class="label">user</div>
            <input class="input" id="inpSshUser" value="${escapeAttr(state.config.ssh.user)}" placeholder="root"/>
          </label>

          <label class="field">
            <div class="label">port</div>
            <input class="input" id="inpSshPort" type="number" value="${Number(state.config.ssh.port || 22)}"/>
          </label>

          <label class="field">
            <div class="label">keyPath</div>
            <input class="input" id="inpSshKeyPath" value="${escapeAttr(state.config.ssh.keyPath)}" placeholder="~/.ssh/id_ed25519"/>
          </label>

          <div class="row">
            <button class="btn" id="btnSshConnect"${state.sshConnectRunning ? " disabled" : ""}>
              ${state.sshConnectRunning ? "Connecting..." : "SSH Connect"}
            </button>
            ${state.sshConnectResult
      ? `<div class="miniBox">
                     <div><b>SSH:</b> ${state.sshConnectResult.sshOk ? "OK" : "NG"}</div>
                     <div><b>remote git:</b> ${state.sshConnectResult.remoteGit.ok
        ? `OK (${escapeHtml(state.sshConnectResult.remoteGit.version || "unknown")})`
        : `NG (${escapeHtml(state.sshConnectResult.remoteGit.error || "unknown error")})`
      }</div>
                     ${state.sshConnectResult.remoteGit.path
        ? `<div class="muted">path: ${escapeHtml(state.sshConnectResult.remoteGit.path)}</div>`
        : ""
      }
                   </div>`
      : ""
    }
        

            ${state.sshConnectResult ? `
              <div class="pill ${state.sshConnectResult.ok ? "ok" : "warn"}">
                <span class="pillDot ${state.sshConnectResult.ok ? "good" : "warn"}"></span>
                ${state.sshConnectResult.ok ? "connected" : "failed"}
              </div>
            ` : ""}
          </div>

          ${state.sshConnectResult && !state.sshConnectResult.ok
      ? `<div class="errorBox">${escapeHtml(String(state.sshConnectResult.stderr ?? "ssh failed"))}</div>`
      : ""
    }
        </div>

        <div class="section">
          <div class="sectionTitle">GitHub (PAT)</div>

          <label class="field">
            <div class="label">username</div>
            <input class="input" id="inpGitHubUsername" value="${escapeAttr(state.config.github.username)}" placeholder="pui-core"/>
          </label>

          <label class="field">
            <div class="label">token</div>
            <input class="input" id="inpGitHubToken" value="${escapeAttr(state.config.github.token)}" placeholder="github_pat_... (保存はlocalStorage)"/>
          </label>

          <div class="muted" style="margin-top:8px; font-size:12px;">
            ※ repo一覧閲覧用です。clone/SSH認証はまだ範囲外（見る→repoUrlへ流し込み）まで。
          </div>
        </div>

        <div class="row right">
          <button class="btn primary" id="btnSettingsSave">Save</button>
        </div>
      </div>
    </div>
  `;
}

function renderAddProjectModal(): string {
  if (!state.addProjectOpen || !state.editingProject) return "";
  const d = state.editingProject.draft;

  return `
    <div class="modalOverlay show" id="addOverlay">
      <div class="modal">
        <div class="modalHeader">
          <div>
            <div class="modalTitle">Add project</div>
            <div class="cardSub">新規projectを追加します</div>
          </div>
          <button class="btn ghost" id="btnAddClose">×</button>
        </div>

        ${renderProjectEditorForm(d, "add")}

        <div class="modalFooter">
          <button class="btn" id="btnAddCancel">キャンセル</button>
          <button class="btn primary" id="btnAddSave">追加</button>
        </div>
      </div>
    </div>
  `;
}

function renderProjectSettingsModal(): string {
  if (!state.projectSettingsOpen || !state.editingProject) return "";
  const d = state.editingProject.draft;

  return `
    <div class="modalOverlay show" id="projectSettingsOverlay">
      <div class="modal">
        <div class="modalHeader">
          <div>
            <div class="modalTitle">Project settings</div>
            <div class="cardSub">${escapeHtml(d.id)}</div>
          </div>
          <button class="btn ghost" id="btnProjSettingsClose">×</button>
        </div>

        ${renderProjectEditorForm(d, "edit")}

        <div class="modalFooter">
          <button class="btn" id="btnProjSettingsCancel">キャンセル</button>
          <button class="btn primary" id="btnProjSettingsSave">保存</button>
        </div>
      </div>
    </div>
  `;
}

function renderProjectEditorForm(d: Project, kind: "add" | "edit"): string {
  const opt = state.editingProject?.branchOptions ?? { test: [], deploy: [] };
  const loading = state.editingProject?.branchLoading ?? { test: false, deploy: false };

  return `
    <div class="formGrid">
      <div class="field span2">
        <div class="label">project name</div>
        <input class="input" id="${kind === "add" ? "inpAddProjName" : "inpEditProjName"}" value="${escapeAttr(d.name)}" placeholder="例: wobbuffet"/>
      </div>

      <div class="field span2">
        <div class="label">test.repoUrl</div>
        <div class="btnRow">
          <input class="input" id="${kind === "add" ? "inpAddTestRepo" : "inpEditTestRepo"}" value="${escapeAttr(d.test.repoUrl)}" placeholder="https://github.com/owner/repo"/>
          <button class="btn" data-github-open="${kind}:${escapeAttr(d.id)}:test">GitHub</button>
          <button class="btn" data-fetch-branches="${kind}:${escapeAttr(d.id)}:test"${loading.test ? " disabled" : ""}>
            ${loading.test ? "取得中…" : "取得"}
          </button>
        </div>
      </div>

      <div class="field span2">
        <div class="label">deploy.repoUrl</div>
        <div class="btnRow">
          <input class="input" id="${kind === "add" ? "inpAddDeployRepo" : "inpEditDeployRepo"}" value="${escapeAttr(d.deploy.repoUrl)}" placeholder="https://github.com/owner/repo"/>
          <button class="btn" data-github-open="${kind}:${escapeAttr(d.id)}:deploy">GitHub</button>
          <button class="btn" data-fetch-branches="${kind}:${escapeAttr(d.id)}:deploy"${loading.deploy ? " disabled" : ""}>
            ${loading.deploy ? "取得中…" : "取得"}
          </button>
        </div>
      </div>

      <div class="field">
        <div class="label">test.branch</div>
        ${renderBranchEditor(kind, "test", d.test.branch, opt.test)}
      </div>

      <div class="field">
        <div class="label">deploy.branch</div>
        ${renderBranchEditor(kind, "deploy", d.deploy.branch, opt.deploy)}
      </div>

      <div class="field">
        <div class="label">test.localPath</div>
        <input class="input" id="${kind === "add" ? "inpAddTestLocal" : "inpEditTestLocal"}" value="${escapeAttr(d.test.localPath)}" placeholder="例: C:\\path\\to\\repo"/>
      </div>

      <div class="field">
        <div class="label">deploy.localPath</div>
        <input class="input" id="${kind === "add" ? "inpAddDeployLocal" : "inpEditDeployLocal"}" value="${escapeAttr(d.deploy.localPath)}" placeholder="例: C:\\path\\to\\repo"/>
      </div>

      <div class="field">
        <div class="label">test.remotePath</div>
        <input class="input" id="${kind === "add" ? "inpAddTestRemote" : "inpEditTestRemote"}" value="${escapeAttr(d.test.remotePath)}" placeholder="例: /home/botadmin/repo"/>
      </div>

      <div class="field">
        <div class="label">deploy.remotePath</div>
        <input class="input" id="${kind === "add" ? "inpAddDeployRemote" : "inpEditDeployRemote"}" value="${escapeAttr(d.deploy.remotePath)}" placeholder="例: /home/botadmin/repo"/>
      </div>
    </div>
  `;
}

function renderBranchEditor(kind: "add" | "edit", envKey: EnvKey, current: string, options: string[]): string {
  const inputId =
    kind === "add"
      ? (envKey === "test" ? "inpAddTestBranch" : "inpAddDeployBranch")
      : (envKey === "test" ? "inpEditTestBranch" : "inpEditDeployBranch");

  if (!options.length) {
    return `<input class="input" id="${inputId}" value="${escapeAttr(current)}" placeholder="main"/>`;
  }

  const opts = options
    .map((b) => `<option value="${escapeAttr(b)}"${b === current ? " selected" : ""}>${escapeHtml(b)}</option>`)
    .join("");

  return `
    <select class="input" id="${inputId}">
      ${opts}
    </select>
  `;
}

function renderDetectModal(): string {
  if (!state.detectOpen) return "";

  const list = state.detectResults.length
    ? state.detectResults
      .map((r) => {
        const key = r.path;
        const checked = !!state.detectSelected[key];
        const label = r.originUrl ? `${r.path} (${r.originUrl})` : r.path;
        return `
            <label class="detectRow">
              <input type="checkbox" data-detect-check="${escapeAttr(key)}"${checked ? " checked" : ""}/>
              <div class="detectText">
                <div class="detectPath">${escapeHtml(label)}</div>
              </div>
            </label>
          `;
      })
      .join("")
    : `<div class="muted">まだ結果がありません</div>`;

  return `
    <div class="modalOverlay show" id="detectOverlay">
      <div class="modal">
        <div class="modalHeader">
          <div>
            <div class="modalTitle">Detect local repos</div>
            <div class="cardSub">root配下から .git を探索して一覧化します</div>
          </div>
          <button class="btn ghost" id="btnDetectClose">×</button>
        </div>

        <div class="formGrid" style="margin-top:12px;">
          <div class="field span2">
            <div class="label">rootPath</div>
            <input class="input" id="inpDetectRootPath" value="${escapeAttr(state.detectRootPath)}" placeholder="例: C:\\Users\\pui\\repo"/>
          </div>
          <div class="field">
            <div class="label">maxDepth</div>
            <input class="input" id="inpDetectMaxDepth" type="number" value="${Number(state.detectMaxDepth)}" min="1" max="12"/>
          </div>
          <div class="field" style="align-self:end;">
            <button class="btn" id="btnDetectRun"${state.detectRunning ? " disabled" : ""}>
              ${state.detectRunning ? "Detecting..." : "Detect"}
            </button>
          </div>
        </div>

        ${state.detectError ? `<div class="errorBox" style="margin-top:10px;">${escapeHtml(state.detectError)}</div>` : ""}

        <div class="detectList">
          ${list}
        </div>

        <div class="modalFooter">
          <button class="btn" id="btnDetectAdd"${state.detectResults.length ? "" : " disabled"}>選択を追加</button>
        </div>
      </div>
    </div>
  `;
}

function renderGitHubModal(): string {
  if (!state.githubOpen) return "";

  const list = state.githubRepos.length
    ? state.githubRepos
      .map((r) => `
          <div class="repoRow">
            <div class="repoMain">
              <div class="repoName">${escapeHtml(r.fullName)}${r.isPrivate ? " 🔒" : ""}</div>
              <div class="repoMeta">
                ⭐ ${r.stargazersCount} · default: ${escapeHtml(r.defaultBranch)} · updated: ${escapeHtml(r.updatedAt)}
              </div>
            </div>
            <div class="repoBtns">
              <button class="btn small" data-copy="${escapeAttr(r.cloneUrl)}">HTTPS</button>
              <button class="btn small" data-copy="${escapeAttr(r.sshUrl)}">SSH</button>
              <button class="btn small" data-use-repo="${escapeAttr(String(r.id))}">Use</button>
            </div>
          </div>
        `)
      .join("")
    : `<div class="muted">まだ一覧がありません（Loadを押してください）</div>`;

  const tokenHint = state.config.github.token.trim()
    ? "PATあり（private含む）"
    : "PAT未設定（Loadできません）";

  return `
    <div class="modalOverlay show" id="githubOverlay">
      <div class="modal">
        <div class="modalHeader">
          <div>
            <div class="modalTitle">GitHub repos</div>
            <div class="cardSub">${escapeHtml(tokenHint)}</div>
          </div>
          <button class="btn ghost" id="btnGithubClose">×</button>
        </div>

        <div class="row" style="margin-top:12px;">
          <button class="btn" id="btnGithubLoad"${state.githubLoading ? " disabled" : ""}>
            ${state.githubLoading ? "Loading..." : "Load my repos"}
          </button>
        </div>

        ${state.githubError ? `<div class="errorBox" style="margin-top:10px;">${escapeHtml(state.githubError)}</div>` : ""}

        <div class="repoList">
          ${list}
        </div>
      </div>
    </div>
  `;
}

function renderCommitModal(): string {
  if (!state.commitOpen) return "";

  const p =
    state.commitProjectId ? state.config.projects.find((x) => x.id === state.commitProjectId) : null;

  const title = p ? `Commit message: ${p.name}` : "Commit message";

  return `
<div class="modalOverlay show" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modalHeader">
      <div class="modalTitle">${escapeHtml(title)}</div>
      <button class="iconButton" id="btnCommitClose" aria-label="Close">✕</button>
    </div>

    <div class="modalBody">
      <div class="hint">
        push（プッシュ / Push）の前に commit（コミット / Commit）を作成します。コメント（message）が必要です。
      </div>

      <label class="field">
        <div class="label">Message</div>
        <input
          id="inpCommitMessage"
          class="input"
          value="${escapeAttr(state.commitMessage)}"
          placeholder="例: update config / fix bug / chore: cleanup"
        />
      </label>
    </div>

    <div class="modalFooter">
      <button class="btn" id="btnCommitCancel">Cancel</button>
      <button class="btn primary" id="btnCommitRun">Commit &amp; Push</button>
    </div>
  </div>
</div>
`;
}


function renderActionModal(): string {
  if (!state.actionOpen) return "";

  const outcome = state.actionOutcome;
  const statusPill = state.actionRunning
    ? `<span class="pill"><span class="pillDot warn"></span>RUNNING</span>`
    : outcome
      ? `<span class="pill"><span class="pillDot ${outcome.ok ? "good" : "bad"}"></span>${outcome.ok ? "OK" : "FAIL"}</span>`
      : state.actionError
        ? `<span class="pill"><span class="pillDot bad"></span>ERROR</span>`
        : `<span class="pill"><span class="pillDot warn"></span>WAIT</span>`;

  const errBlock = state.actionError
    ? `<div class="errorBox" style="margin-top:12px;">${escapeHtml(state.actionError)}</div>`
    : outcome?.error
      ? `<div class="errorBox" style="margin-top:12px;">
           ${escapeHtml(`${outcome.error.severity} ${outcome.error.code}: ${outcome.error.message}`)}
         </div>`
      : "";

  const steps = outcome?.steps?.length
    ? outcome.steps
      .map((s, i) => `
          <details class="stepBox">
            <summary>
              <div><b>step ${i + 1}</b> <span class="muted">exit=${String(s.exitCode ?? "")}</span></div>
              <span class="pill"><span class="pillDot ${s.ok ? "good" : "bad"}"></span>${s.ok ? "OK" : "FAIL"}</span>
            </summary>
            <div class="stepMeta">
              ${s.cwd ? `cwd: ${escapeHtml(String(s.cwd))}<br/>` : ""}
              cmd: <span class="stepCmd">${escapeHtml(s.cmd)}</span>
            </div>
            ${s.stdout?.trim() ? `<pre class="stepLog">${escapeHtml(s.stdout)}</pre>` : ""}
            ${s.stderr?.trim() ? `<pre class="stepLog">${escapeHtml(s.stderr)}</pre>` : ""}
          </details>
        `)
      .join("")
    : `<div class="muted" style="margin-top:12px;">${state.actionRunning ? "実行中…" : "ログはまだありません"}</div>`;

  return `
    <div class="modalOverlay show" id="actionOverlay">
      <div class="modal">
        <div class="modalHeader">
          <div>
            <div class="modalTitle">Action</div>
            <div class="cardSub">${escapeHtml(state.actionTitle)}</div>
          </div>
          <div class="btnRow">
            ${statusPill}
            <button class="btn ghost" id="btnActionClose">×</button>
          </div>
        </div>

        ${errBlock}

        <div class="row" style="margin-top:12px;">
          <button class="btn" id="btnActionCopy">ログをコピー</button>
          <button class="btn" id="btnActionRecheck"${state.preflightRunning ? " disabled" : ""}>preflight再チェック</button>
        </div>

        <div style="margin-top:12px;">
          ${steps}
        </div>
      </div>
    </div>
  `;
}

function renderToast(): string {
  const t = state.toast;
  if (!t) return "";
  const now = Date.now();
  const show = now < t.until;
  return `<div class="toast ${show ? "show" : ""}">${escapeHtml(t.text)}</div>`;
}

function bindHandlers(): void {
  // Home
  byId("btnHomeSsh")?.addEventListener("click", () => enterWorkspace("ssh"));
  byId("btnHomeLocal")?.addEventListener("click", () => enterWorkspace("local"));
  byId("btnHomeExit")?.addEventListener("click", () => window.close());

  // Workspace
  byId("btnGoHome")?.addEventListener("click", () => goHome());
  byId("btnDrawerToggle")?.addEventListener("click", () => toggleDrawer());
  byId("btnAddProject")?.addEventListener("click", () => openAddProject());
  byId("btnDetectRepos")?.addEventListener("click", () => openDetectRepos());

  // Settings
  byId("btnSettingsFab")?.addEventListener("click", () => openSettings());
  byId("btnSettingsClose")?.addEventListener("click", () => closeSettings());
  byId("btnRunPreflight")?.addEventListener("click", () => void runPreflight());
  byId("btnSshConnect")?.addEventListener("click", () => void runSshConnect());
  byId("btnSshConnectTop")?.addEventListener("click", () => void runSshConnect());

  byId("btnSettingsSave")?.addEventListener("click", () => {
    state.config.toolPaths.gitPath = (byId<HTMLInputElement>("inpGitPath")?.value ?? "").trim();
    state.config.toolPaths.sshPath = (byId<HTMLInputElement>("inpSshPath")?.value ?? "").trim();

    state.config.ssh.host = (byId<HTMLInputElement>("inpSshHost")?.value ?? "").trim();
    state.config.ssh.user = (byId<HTMLInputElement>("inpSshUser")?.value ?? "").trim();
    state.config.ssh.port = clampInt(Number(byId<HTMLInputElement>("inpSshPort")?.value ?? 22), 1, 65535, 22);
    state.config.ssh.keyPath = (byId<HTMLInputElement>("inpSshKeyPath")?.value ?? "").trim();

    state.config.github.username = (byId<HTMLInputElement>("inpGitHubUsername")?.value ?? "").trim();
    state.config.github.token = (byId<HTMLInputElement>("inpGitHubToken")?.value ?? "").trim();

    saveConfig();
    toast("Saved");
    closeSettings();
  });

  // Drawer item selection
  document.querySelectorAll<HTMLElement>("[data-project-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-project-id");
      if (!id) return;
      selectProject(id);
    });
  });

  // Project card actions
  document.querySelectorAll<HTMLElement>("[data-pin-project]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = el.getAttribute("data-pin-project");
      if (!id) return;
      togglePin(id);
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-open-project-settings]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = el.getAttribute("data-open-project-settings");
      if (!id) return;
      openProjectSettings(id);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-select-env]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const key = el.getAttribute("data-select-env");
      if (!key) return;
      const [projectId, envKey] = key.split(":");
      if (!projectId || (envKey !== "test" && envKey !== "deploy")) return;
      setSelectedEnvKeyForProject(projectId, envKey);
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const key = el.getAttribute("data-action");
      if (!key) return;
      const [projectId, op] = key.split(":");
      if (!projectId) return;
      if (op !== "pull" && op !== "push" && op !== "merge") return;
      if (op === "push") {
        openCommitModal(projectId);
        return;
      }
      void runProjectAction(projectId, op);

    });
  });

  // Add modal
  byId("btnAddClose")?.addEventListener("click", () => closeAddProject());
  byId("btnAddCancel")?.addEventListener("click", () => closeAddProject());
  byId("btnAddSave")?.addEventListener("click", () => saveAddProject());

  // Project settings modal
  byId("btnProjSettingsClose")?.addEventListener("click", () => closeProjectSettings());
  byId("btnProjSettingsCancel")?.addEventListener("click", () => closeProjectSettings());
  byId("btnProjSettingsSave")?.addEventListener("click", () => saveProjectSettings());

  // Project editor: GitHub open / Fetch branches
  document.querySelectorAll<HTMLElement>("[data-github-open]").forEach((el) => {
    el.addEventListener("click", () => {
      const v = el.getAttribute("data-github-open") || "";
      const parts = v.split(":");
      if (parts.length !== 3) return;
      const kind = parts[0] as "add" | "edit";
      const projectId = parts[1];
      const envKey = parts[2] as EnvKey;
      openGitHubModal(kind, kind === "edit" ? projectId : "", envKey);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-fetch-branches]").forEach((el) => {
    el.addEventListener("click", () => {
      const v = el.getAttribute("data-fetch-branches") || "";
      const parts = v.split(":");
      if (parts.length !== 3) return;
      const kind = parts[0] as "add" | "edit";
      const envKey = parts[2] as EnvKey;
      void fetchBranches(kind, envKey);
    });
  });

  // Detect modal
  byId("btnDetectClose")?.addEventListener("click", () => closeDetectRepos());
  byId("btnDetectRun")?.addEventListener("click", () => void runDetectRepos());
  byId("btnDetectAdd")?.addEventListener("click", () => addDetectedReposToProjects());

  byId<HTMLInputElement>("inpDetectRootPath")?.addEventListener("input", (e) => {
    state.detectRootPath = (e.target as HTMLInputElement).value;
  });
  byId<HTMLInputElement>("inpDetectMaxDepth")?.addEventListener("input", (e) => {
    state.detectMaxDepth = clampInt(Number((e.target as HTMLInputElement).value), 1, 12, 4);
  });

  document.querySelectorAll<HTMLInputElement>("[data-detect-check]").forEach((el) => {
    el.addEventListener("change", () => {
      const key = el.getAttribute("data-detect-check") || "";
      if (!key) return;
      state.detectSelected[key] = el.checked;
    });
  });

  // GitHub modal
  byId("btnGithubClose")?.addEventListener("click", () => closeGitHubModal());
  byId("btnGithubLoad")?.addEventListener("click", () => void loadMyGitHubRepos());

  document.querySelectorAll<HTMLElement>("[data-copy]").forEach((el) => {
    el.addEventListener("click", async () => {
      const text = el.getAttribute("data-copy") || "";
      await copyText(text);
      toast("Copied");
    });
  });

  document.querySelectorAll<HTMLElement>("[data-use-repo]").forEach((el) => {
    el.addEventListener("click", () => {
      const idStr = el.getAttribute("data-use-repo") || "";
      const id = Number(idStr);
      const repo = state.githubRepos.find((r) => r.id === id);
      if (!repo) return;
      applyRepoToTarget(repo.cloneUrl);
      closeGitHubModal();
    });
  });

  // Action modal
  byId("btnActionClose")?.addEventListener("click", () => closeActionModal());
  byId("btnActionCopy")?.addEventListener("click", async () => {
    await copyText(buildActionLogText());
    toast("Copied");
  });
  byId("btnActionRecheck")?.addEventListener("click", () => void runPreflight());
  byId("btnCommitClose")?.addEventListener("click", () => closeCommitModal());
  byId("btnCommitCancel")?.addEventListener("click", () => closeCommitModal());
  byId("btnCommitRun")?.addEventListener("click", () => void commitAndPush());
  byId<HTMLInputElement>("inpCommitMessage")?.addEventListener("input", (e) => {
    state.commitMessage = (e.target as HTMLInputElement).value;
  });
}

function enterWorkspace(mode: Mode): void {
  state.ui.mode = mode;
  state.ui.screen = "workspace";

  normalizeSelectionForMode();

  saveUiState();
  render();
}

function goHome(): void {
  state.ui.screen = "home";
  saveUiState();
  render();
}

function toggleDrawer(): void {
  state.ui.drawerOpen = !state.ui.drawerOpen;
  saveUiState();
  render();
}

function openSettings(): void {
  state.settingsOpen = true;
  render();
}

function closeSettings(): void {
  state.settingsOpen = false;
  render();
}

function projectHasLocal(p: Project): boolean {
  return !!((p.test.localPath ?? "").trim() || (p.deploy.localPath ?? "").trim());
}

function projectHasRemote(p: Project): boolean {
  return !!((p.test.remotePath ?? "").trim() || (p.deploy.remotePath ?? "").trim());
}

function visibleProjects(): Project[] {
  if (state.ui.mode === "ssh") {
    return state.config.projects.filter((p) => projectHasRemote(p));
  }
  return state.config.projects.filter((p) => projectHasLocal(p));
}

function normalizeSelectionForMode(): void {
  const visibleIds = new Set(visibleProjects().map((p) => p.id));

  if (state.ui.selectedProjectId && !visibleIds.has(state.ui.selectedProjectId)) {
    const next = state.ui.pinnedProjectIds.find((id) => visibleIds.has(id)) ?? null;
    state.ui.selectedProjectId = next;
  }
}

function pinnedProjects(): Project[] {
  const visibleIds = new Set(visibleProjects().map((p) => p.id));
  const idToProject = new Map(state.config.projects.map((p) => [p.id, p]));

  return state.ui.pinnedProjectIds
    .filter((id) => visibleIds.has(id))
    .map((id) => idToProject.get(id))
    .filter(Boolean) as Project[];
}

function selectProject(projectId: string): void {
  state.ui.selectedProjectId = projectId;
  // 選んだらpinして作業対象にする
  if (!state.ui.pinnedProjectIds.includes(projectId)) {
    state.ui.pinnedProjectIds = [projectId, ...state.ui.pinnedProjectIds].slice(0, PIN_LIMIT);
  }
  saveUiState();
  render();
}

function togglePin(projectId: string): void {
  const idx = state.ui.pinnedProjectIds.indexOf(projectId);
  if (idx >= 0) {
    state.ui.pinnedProjectIds.splice(idx, 1);
    if (state.ui.selectedProjectId === projectId) {
      const visibleIds = new Set(visibleProjects().map((p) => p.id));
      state.ui.selectedProjectId =
        state.ui.pinnedProjectIds.find((id) => visibleIds.has(id)) ?? null;
    }
  } else {
    state.ui.pinnedProjectIds = [projectId, ...state.ui.pinnedProjectIds].slice(0, PIN_LIMIT);
    state.ui.selectedProjectId = projectId;
  }
  saveUiState();
}


function selectedEnvKeyForProject(projectId: string): EnvKey {
  const v = state.ui.selectedEnvByProject[projectId];
  return v === "deploy" ? "deploy" : "test";
}

function setSelectedEnvKeyForProject(projectId: string, envKey: EnvKey): void {
  state.ui.selectedEnvByProject[projectId] = envKey;
  saveUiState();
}

function openAddProject(): void {
  state.addProjectOpen = true;
  state.projectSettingsOpen = false;
  state.editingProject = {
    projectId: null,
    draft: defaultProject(),
    branchOptions: { test: [], deploy: [] },
    branchLoading: { test: false, deploy: false },
  };
  render();
}

function closeAddProject(): void {
  state.addProjectOpen = false;
  state.editingProject = undefined;
  render();
}

async function saveAddProject(): Promise<void> {
  if (!state.editingProject) return;
  const d = readProjectEditorDraft("add", state.editingProject.draft);

  if (!d.name.trim()) {
    toast("project name is required");
    return;
  }

  state.config.projects.unshift(d);
  saveConfig();

  // 追加したらpinして選択
  state.ui.pinnedProjectIds = [d.id, ...state.ui.pinnedProjectIds].slice(0, PIN_LIMIT);
  state.ui.selectedProjectId = d.id;
  saveUiState();

  state.addProjectOpen = false;
  state.editingProject = undefined;

  toast("Added");
  render();

  await maybeAutoInitLocalRepos(d);
}


function openProjectSettings(projectId: string): void {
  const p = state.config.projects.find((x) => x.id === projectId);
  if (!p) return;

  state.projectSettingsOpen = true;
  state.addProjectOpen = false;

  state.editingProject = {
    projectId,
    draft: deepClone(p),
    branchOptions: { test: [], deploy: [] },
    branchLoading: { test: false, deploy: false },
  };

  render();
}

function closeProjectSettings(): void {
  state.projectSettingsOpen = false;
  state.editingProject = undefined;
  render();
}

async function saveProjectSettings(): Promise<void> {
  if (!state.editingProject?.projectId) return;

  const projectId = state.editingProject.projectId;
  const d = readProjectEditorDraft("edit", state.editingProject.draft);

  if (!d.name.trim()) {
    toast("project name is required");
    return;
  }

  const idx = state.config.projects.findIndex((x) => x.id === projectId);
  if (idx < 0) return;

  state.config.projects[idx] = d;
  saveConfig();

  toast("Saved");
  closeProjectSettings();

  await maybeAutoInitLocalRepos(d);
}

function readProjectEditorDraft(kind: "add" | "edit", base: Project): Project {
  const d = deepClone(base);

  const nameId = kind === "add" ? "inpAddProjName" : "inpEditProjName";
  d.name = (byId<HTMLInputElement>(nameId)?.value ?? "").trim();

  const testRepoId = kind === "add" ? "inpAddTestRepo" : "inpEditTestRepo";
  const deployRepoId = kind === "add" ? "inpAddDeployRepo" : "inpEditDeployRepo";
  d.test.repoUrl = (byId<HTMLInputElement>(testRepoId)?.value ?? "").trim();
  d.deploy.repoUrl = (byId<HTMLInputElement>(deployRepoId)?.value ?? "").trim();

  const testBranchId = kind === "add" ? "inpAddTestBranch" : "inpEditTestBranch";
  const deployBranchId = kind === "add" ? "inpAddDeployBranch" : "inpEditDeployBranch";
  d.test.branch = readInputOrSelectValue(testBranchId).trim() || "main";
  d.deploy.branch = readInputOrSelectValue(deployBranchId).trim() || "main";

  const testLocalId = kind === "add" ? "inpAddTestLocal" : "inpEditTestLocal";
  const deployLocalId = kind === "add" ? "inpAddDeployLocal" : "inpEditDeployLocal";
  d.test.localPath = (byId<HTMLInputElement>(testLocalId)?.value ?? "").trim();
  d.deploy.localPath = (byId<HTMLInputElement>(deployLocalId)?.value ?? "").trim();

  const testRemoteId = kind === "add" ? "inpAddTestRemote" : "inpEditTestRemote";
  const deployRemoteId = kind === "add" ? "inpAddDeployRemote" : "inpEditDeployRemote";
  d.test.remotePath = (byId<HTMLInputElement>(testRemoteId)?.value ?? "").trim();
  d.deploy.remotePath = (byId<HTMLInputElement>(deployRemoteId)?.value ?? "").trim();

  return d;
}

function readInputOrSelectValue(id: string): string {
  const el = byId<HTMLInputElement | HTMLSelectElement>(id);
  if (!el) return "";
  if (el instanceof HTMLSelectElement) return el.value ?? "";
  return el.value ?? "";
}

async function runPreflight(): Promise<void> {
  state.preflightRunning = true;
  state.preflightError = undefined;
  render();

  if (!isTauri()) {
    state.preflightRunning = false;
    state.preflightError = "Tauri環境ではないため実行できません（ブラウザ表示のみ）";
    render();
    return;
  }

  try {
    const gitPath = state.config.toolPaths.gitPath.trim() || null;
    const sshPath = state.config.toolPaths.sshPath.trim() || null;

    const res = await invoke<PreflightResultWire>("preflight", { gitPath, sshPath });
    state.preflight = res;
    state.preflightRunning = false;
    render();
  } catch (e: any) {
    state.preflightRunning = false;
    state.preflightError = String(e?.message ?? e);
    render();
  }
}

async function runSshConnect(): Promise<void> {
  state.sshConnectRunning = true;
  state.sshConnectResult = undefined;
  render();

  if (!isTauri()) {
    state.sshConnectRunning = false;
    state.sshConnectResult = {
      ok: false,
      sshOk: false,
      stderr: "Tauri環境ではないため実行できません",
      remoteGit: { found: false, ok: false, error: "remote git not checked" },
    };
    render();
    return;
  }

  try {
    const sshPath = state.config.toolPaths.sshPath.trim() || null;

    const ssh = {
      host: state.config.ssh.host.trim(),
      user: state.config.ssh.user.trim(),
      port: state.config.ssh.port,
      keyPath: state.config.ssh.keyPath.trim(),
    };

    const res = await invoke<SshConnectResultWire>("ssh_connect", { sshPath, ssh });
    state.sshConnectResult = res;

    // SSHモード & SSH疎通OK なら remote の .git を軽く走査して project を自動追加（重複は追加しない）
    if (state.ui.mode === "ssh" && res.sshOk) {
      try {
        const repos = await invoke<DetectRepoWire[]>("detect_remote_repos", {
          sshPath,
          ssh,
          rootPath: "",
          maxDepth: 6,
          maxRepos: 50,
        });

        const list = Array.isArray(repos) ? repos : [];
        if (!list.length) {
          toast("remote repos not found (0)");
        } else {
          const existingRemotePaths = new Set<string>();
          for (const p of state.config.projects) {
            const a = p?.test?.remotePath?.trim();
            const b = p?.deploy?.remotePath?.trim();
            if (a) existingRemotePaths.add(a);
            if (b) existingRemotePaths.add(b);
          }

          const newProjects: Project[] = [];

          for (const r of list) {
            const rp = r?.path?.trim();
            if (!rp) continue;
            if (existingRemotePaths.has(rp)) continue;

            const proj = defaultProject();
            proj.name = r.name && r.name.trim() ? r.name.trim() : basename(rp);

            proj.test.remotePath = rp;
            proj.deploy.remotePath = rp;

            if (r.originUrl && r.originUrl.trim()) {
              proj.test.repoUrl = r.originUrl.trim();
              proj.deploy.repoUrl = r.originUrl.trim();
            }

            newProjects.push(proj);
            existingRemotePaths.add(rp);
          }

          if (newProjects.length) {
            state.config.projects.push(...newProjects);

            for (const p of newProjects) {
              if (state.ui.pinnedProjectIds.length >= PIN_LIMIT) break;
              state.ui.pinnedProjectIds.push(p.id);
            }

            saveConfig();
            saveUiState();
            toast(`remote repos imported: +${newProjects.length}`);
          } else {
            toast("remote repos found but all duplicated");
          }
        }
      } catch (e: any) {
        toast(`remote repos import failed: ${String(e?.message ?? e)}`);
      }
    }

    state.sshConnectRunning = false;
    render();
  } catch (e: any) {
    state.sshConnectRunning = false;
    state.sshConnectResult = {
      ok: false,
      sshOk: false,
      stderr: String(e?.message ?? e),
      remoteGit: { found: false, ok: false, error: "remote git not checked" },
    };
    render();
  }
}



function openDetectRepos(): void {
  state.detectOpen = true;
  state.detectResults = [];
  state.detectSelected = {};
  state.detectError = undefined;
  state.detectRunning = false;
  render();
}

function closeDetectRepos(): void {
  state.detectOpen = false;
  render();
}

async function runDetectRepos(): Promise<void> {
  state.detectRunning = true;
  state.detectResults = [];
  state.detectSelected = {};
  state.detectError = undefined;
  render();

  if (!isTauri()) {
    state.detectRunning = false;
    state.detectError = "Detect is available only in Tauri runtime.";
    render();
    return;
  }

  const maxDepth = clampInt(state.detectMaxDepth, 1, 12, 8);

  // LOCAL
  if (state.ui.mode === "local") {
    const rootPath = normalizePathInput(state.detectRootPath);
    state.detectRootPath = rootPath;

    if (!rootPath) {
      state.detectRunning = false;
      state.detectError = "Root path is required.";
      render();
      return;
    }

    try {
      const gitPath = state.config.toolPaths.gitPath || "";
      const res = (await invoke("detect_local_repos", {
        rootPath,
        maxDepth,
        gitPath,
      })) as DetectReposResultWire;

      state.detectResults = res.repos.map((r) => ({
        path: r.path,
        name: r.name,
        envKey: "local",
        hasRemote: r.hasRemote,
        remoteUrl: r.remoteUrl ?? null,
      }));

      state.detectSelected = {};
      for (const r of state.detectResults) state.detectSelected[r.path] = true;

      if (state.detectResults.length === 0) {
        state.detectError = "No git repositories found.";
      }

      state.detectRunning = false;
      render();
      return;
    } catch (e) {
      state.detectRunning = false;
      state.detectError = `Detect failed: ${String(e)}`;
      render();
      return;
    }
  }

  // SSH
  if (!state.sshConnectResult?.sshOk) {
    state.detectRunning = false;
    state.detectError = "SSH is not connected. Run SSH Connect first.";
    render();
    return;
  }

  const rootPath = state.detectRootPath.trim();
  state.detectRootPath = rootPath;

  if (!rootPath) {
    state.detectRunning = false;
    state.detectError = "Root path is required.";
    render();
    return;
  }

  try {
    const ssh = state.config.ssh;
    const gitPath = state.config.toolPaths.gitPath || "";
    const sshPath = state.config.toolPaths.sshPath || "";
    const res = (await invoke("detect_remote_repos", {
      rootPath,
      maxDepth,
      gitPath,
      sshPath,
      ssh,
    })) as DetectReposResultWire;

    state.detectResults = res.repos.map((r) => ({
      path: r.path,
      name: r.name,
      envKey: "ssh",
      hasRemote: r.hasRemote,
      remoteUrl: r.remoteUrl ?? null,
    }));

    state.detectSelected = {};
    for (const r of state.detectResults) state.detectSelected[r.path] = true;

    if (state.detectResults.length === 0) {
      state.detectError = "No git repositories found on remote.";
    }

    state.detectRunning = false;
    render();
    return;
  } catch (e) {
    state.detectRunning = false;
    state.detectError = `Detect failed: ${String(e)}`;
    render();
    return;
  }
}



function addDetectedReposToProjects(): void {
  const selected = state.detectResults.filter((r) => !!state.detectSelected[r.path]);
  if (!selected.length) {
    toast("選択がありません");
    return;
  }

  const existLocalPaths = new Set<string>();
  for (const p of state.config.projects) {
    if (p.test.localPath) existLocalPaths.add(p.test.localPath);
    if (p.deploy.localPath) existLocalPaths.add(p.deploy.localPath);
  }

  const newProjects: Project[] = [];
  for (const r of selected) {
    if (existLocalPaths.has(r.path)) continue;

    const proj = defaultProject();
    proj.name = (r.name && r.name.trim()) ? r.name.trim() : basename(r.path);
    if (state.ui.mode === "local") {
      proj.test.localPath = r.path;
      proj.deploy.localPath = r.path;
    } else {
      proj.test.remotePath = r.path;
      proj.deploy.remotePath = r.path;
    }


    if (r.originUrl) {
      proj.test.repoUrl = r.originUrl;
      proj.deploy.repoUrl = r.originUrl;
    }

    newProjects.push(proj);
  }

  if (!newProjects.length) {
    toast("追加対象がありません（既に登録済みの可能性）");
    return;
  }

  state.config.projects = [...newProjects, ...state.config.projects];
  saveConfig();

  // 追加した分をpin
  const ids = newProjects.map((p) => p.id);
  state.ui.pinnedProjectIds = uniqueKeepOrder([...ids, ...state.ui.pinnedProjectIds]).slice(0, 12);
  state.ui.selectedProjectId = ids[0] ?? state.ui.selectedProjectId;
  saveUiState();

  toast(`Added ${newProjects.length}`);
  closeDetectRepos();
  render();
}

function openGitHubModal(kind: "add" | "edit", projectId: string, envKey: EnvKey): void {
  state.githubOpen = true;
  state.githubError = undefined;
  state.githubRepos = [];
  state.githubLoading = false;

  if (kind === "add") {
    state.githubTarget = { kind: "add", envKey };
  } else {
    state.githubTarget = { kind: "edit", projectId, envKey };
  }

  render();
}

function closeGitHubModal(): void {
  state.githubOpen = false;
  state.githubLoading = false;
  state.githubError = undefined;
  state.githubTarget = null;
  render();
}

async function loadMyGitHubRepos(): Promise<void> {
  const token = state.config.github.token.trim();
  if (!token) {
    state.githubError = "PAT(token) が未設定です（Settingsで入力してください）";
    render();
    return;
  }

  state.githubLoading = true;
  state.githubError = undefined;
  render();

  try {
    const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API failed: ${res.status} ${res.statusText} ${text}`);
    }

    const json = (await res.json()) as any[];
    state.githubRepos = (json || []).map((r) => ({
      id: Number(r.id),
      fullName: String(r.full_name ?? ""),
      cloneUrl: String(r.clone_url ?? ""),
      sshUrl: String(r.ssh_url ?? ""),
      defaultBranch: String(r.default_branch ?? ""),
      updatedAt: String(r.updated_at ?? ""),
      stargazersCount: Number(r.stargazers_count ?? 0),
      isPrivate: Boolean(r.private ?? false),
    }));

    state.githubLoading = false;
    render();
  } catch (e: any) {
    state.githubLoading = false;
    state.githubError = String(e?.message ?? e);
    render();
  }
}

function applyRepoToTarget(repoUrl: string): void {
  if (!state.editingProject) return;
  const target = state.githubTarget;
  if (!target) return;

  const d = state.editingProject.draft;

  if (target.kind === "add") {
    if (target.envKey === "test") d.test.repoUrl = repoUrl;
    else d.deploy.repoUrl = repoUrl;
  } else {
    // edit
    if (target.envKey === "test") d.test.repoUrl = repoUrl;
    else d.deploy.repoUrl = repoUrl;
  }

  state.editingProject.draft = d;
  render();
}

async function fetchBranches(kind: "add" | "edit", envKey: EnvKey): Promise<void> {
  if (!state.editingProject) return;

  // draftをDOMから同期
  state.editingProject.draft = readProjectEditorDraft(kind, state.editingProject.draft);

  const repoUrl = envKey === "test" ? state.editingProject.draft.test.repoUrl : state.editingProject.draft.deploy.repoUrl;
  if (!repoUrl.trim()) {
    toast("repoUrl が未設定です");
    return;
  }

  state.editingProject.branchLoading[envKey] = true;
  render();

  if (!isTauri()) {
    state.editingProject.branchLoading[envKey] = false;
    toast("Tauri環境ではないため取得できません");
    render();
    return;
  }

  try {
    const gitPath = state.config.toolPaths.gitPath.trim() || null;
    const res = await invoke<BranchListWire>("list_branches", { repoUrl, gitPath });

    const branches = Array.isArray(res?.branches) ? res.branches : [];
    state.editingProject.branchOptions[envKey] = branches;

    // current branch が空なら default に寄せる（無ければ main）
    if (envKey === "test") {
      if (!state.editingProject.draft.test.branch.trim()) state.editingProject.draft.test.branch = branches[0] ?? "main";
    } else {
      if (!state.editingProject.draft.deploy.branch.trim()) state.editingProject.draft.deploy.branch = branches[0] ?? "main";
    }

    state.editingProject.branchLoading[envKey] = false;
    render();
  } catch (e: any) {
    state.editingProject.branchLoading[envKey] = false;
    toast(String(e?.message ?? e));
    render();
  }
}

async function runProjectAction(projectId: string, op: ActionOp, commitMessage: string | null = null): Promise<void> {
  const p = state.config.projects.find((x) => x.id === projectId);
  if (!p) return;

  const envKey = selectedEnvKeyForProject(projectId);
  const env = envKey === "deploy" ? p.deploy : p.test;
  if (!env) return;

  const localPath = env.localPath || "";
  const remotePath = env.remotePath || "";

  const gitPath = state.config.toolPaths.gitPath || "";
  const ssh = state.config.ssh;
  const sshPath = state.config.toolPaths.sshPath || "";
  // mergeFromBranch: for merge operations, use the opposite env's branch (test merges from deploy, deploy merges from test)
  const mergeFromBranch = envKey === "test" ? p.deploy.branch : p.test.branch;

  state.actionOpen = true;
  state.actionRunning = true;
  state.actionTitle = `${p.name} / ${op} / ${env.branch}`;
  state.actionOutcome = undefined;
  state.actionError = undefined;
  render();

  if (!isTauri()) {
    state.actionRunning = false;
    state.actionError = "Action is available only in Tauri runtime.";
    render();
    return;
  }

  try {
    const req = {
      mode: state.ui.mode,
      envKey,
      action: op,
      localPath,
      remotePath,
      branch: env.branch,
      gitPath,
      ssh,
      sshPath,
      mergeFromBranch: state.ui.mode === "local" ? mergeFromBranch : null,
      commitMessage: op === "push" ? (commitMessage?.trim() || null) : null,
    };

    const res = (await invoke("run_action", { req })) as ActionOutcomeWire;
    state.actionOutcome = res;
    state.actionRunning = false;
    render();
  } catch (e) {
    state.actionRunning = false;
    state.actionError = `Action failed: ${String(e)}`;
    render();
  }
}


// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _openActionModal(title: string): void {
  state.actionOpen = true;
  state.actionTitle = title;
  state.actionOutcome = undefined;
  state.actionError = undefined;
  state.actionRunning = false;
  render();
}

function openCommitModal(projectId: string): void {
  state.commitOpen = true;
  state.commitProjectId = projectId;
  state.commitMessage = "";
  render();
}

function closeCommitModal(): void {
  state.commitOpen = false;
  state.commitProjectId = null;
  state.commitMessage = "";
  render();
}

async function commitAndPush(): Promise<void> {
  const projectId = state.commitProjectId;
  if (!projectId) return;

  const message = state.commitMessage.trim();
  if (!message) {
    toast("コミットメッセージを入力してください");
    return;
  }

  closeCommitModal();
  await runProjectAction(projectId, "push", message);
}

async function maybeAutoInitLocalRepos(project: Project): Promise<void> {
  if (!isTauri()) return;

  const envKeys: EnvKey[] = ["test", "deploy"];
  const targets = envKeys
    .map((k) => ({
      envKey: k,
      env: k === "test" ? project.test : project.deploy,
    }))
    .filter((x) => !!(x.env.localPath || "").trim());

  if (targets.length === 0) return;

  for (const t of targets) {
    try {
      const payload: Record<string, unknown> = {
        localPath: t.env.localPath,
        gitPath: state.config.toolPaths.gitPath || "",
      };

      if ((t.env.repoUrl || "").trim()) payload.repoUrl = t.env.repoUrl;
      if ((t.env.branch || "").trim()) payload.defaultBranch = t.env.branch;

      await invoke("init_local_repo", payload);

    } catch (e) {
      // init失敗は致命ではないのでtoastで通知だけ
      toast(`init failed: ${String(e)}`);
    }
  }
}


// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _mergeInitOutcomes(list: Array<{ envKey: EnvKey; out: ActionOutcomeWire }>): ActionOutcomeWire {
  const steps: StepResultWire[] = [];
  let okAll = true;
  let firstError: ActionErrorWire | null = null;

  for (const item of list) {
    okAll = okAll && !!item.out.ok;

    if (!item.out.ok && item.out.error && !firstError) {
      firstError = item.out.error;
    }

    const s = item.out.steps ?? [];
    for (const step of s) {
      steps.push({
        ...step,
        cmd: `[${item.envKey}] ${step.cmd}`,
      });
    }
  }

  return {
    ok: okAll,
    envKey: "init",
    action: "init",
    steps,
    error: firstError,
  };
}


function closeActionModal(): void {
  state.actionOpen = false;
  state.actionTitle = "";
  state.actionOutcome = undefined;
  state.actionError = undefined;
  state.actionRunning = false;
  render();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _buildActionTitle(p: Project, envKey: EnvKey, op: ActionOp, branch: string): string {
  return `${p.name || p.id} / ${envKey} / ${op} / ${branch}`;
}

function buildActionLogText(): string {
  const out = state.actionOutcome;
  const lines: string[] = [];
  lines.push(`title: ${state.actionTitle}`);
  if (state.actionError) lines.push(`error: ${state.actionError}`);

  if (out) {
    lines.push(`ok: ${String(out.ok)}`);
    if (out.error) lines.push(`error: ${out.error.severity} ${out.error.code}: ${out.error.message}`);
    const steps = out.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      lines.push("");
      lines.push(`--- step ${i + 1} ---`);
      lines.push(`ok=${String(s.ok)} exit=${String(s.exitCode ?? "")}`);
      if (s.cwd) lines.push(`cwd=${s.cwd}`);
      lines.push(`cmd=${s.cmd}`);
      if (s.stdout?.trim()) lines.push(`stdout:\n${s.stdout}`);
      if (s.stderr?.trim()) lines.push(`stderr:\n${s.stderr}`);
    }
  }

  return lines.join("\n");
}

function toast(text: string, ms: number = 2200): void {
  state.toast = { text, until: Date.now() + ms };
  render();
  window.setTimeout(() => {
    if (!state.toast) return;
    if (Date.now() >= state.toast.until) {
      state.toast = undefined;
      render();
    }
  }, ms + 20);
}

function isTauri(): boolean {
  const w = window as any;
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__); // v2/v1 どちらにも耐える
}

function makeId(): string {
  const a = Math.random().toString(16).slice(2);
  const b = Date.now().toString(16);
  return `p_${b}_${a}`;
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function basename(path: string): string {
  const s = String(path ?? "");
  const parts = s.split(/[/\\]/g).filter(Boolean);
  return parts[parts.length - 1] ?? s;
}
function normalizePathInput(s: string): string {
  const t = String(s ?? "").trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}


function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const x = Math.trunc(n);
  return Math.max(min, Math.min(max, x));
}

function uniqueKeepOrder<T>(arr: T[]): T[] {
  const out: T[] = [];
  const set = new Set<T>();
  for (const v of arr) {
    if (set.has(v)) continue;
    set.add(v);
    out.push(v);
  }
  return out;
}

function shorten(s: string): string {
  const x = (s ?? "").trim();
  if (!x) return "(未設定)";
  if (x.length <= 42) return x;
  return `${x.slice(0, 16)}…${x.slice(-20)}`;
}

async function copyText(text: string): Promise<void> {
  const t = String(text ?? "");
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function escapeHtml(s: string): string {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll("`", "&#096;");
}
