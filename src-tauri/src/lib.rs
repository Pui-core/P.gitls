// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
#[tauri::command(rename_all = "camelCase")]
fn init_local_repo(
    git_path: Option<String>,
    local_path: String,
    repo_url: Option<String>,
    default_branch: Option<String>,
) -> ActionOutcome {
    let mut steps: Vec<StepResult> = Vec::new();

    let Some(git) = git_exe(git_path) else {
        return ActionOutcome {
            ok: false,
            mode: "local".into(),
            env_key: "init".into(),
            action: "init".into(),
            steps,
            error: Some(ActionError {
                severity: "FATAL".into(),
                code: "GIT-0001".into(),
                message: "git not found. Run preflight and set gitPath if needed.".into(),
                detail: None,
            }),
        };
    };

    let lp = local_path.trim().to_string();
    if lp.is_empty() {
        return ActionOutcome {
            ok: false,
            mode: "local".into(),
            env_key: "init".into(),
            action: "init".into(),
            steps,
            error: Some(ActionError {
                severity: "ERROR".into(),
                code: "GIT-0401".into(),
                message: "localPath is required".into(),
                detail: None,
            }),
        };
    }

    let dir = PathBuf::from(&lp);

    if !dir.exists() {
        match std::fs::create_dir_all(&dir) {
            Ok(_) => {
                steps.push(StepResult {
                    ok: true,
                    cmd: format!("mkdir -p {}", lp),
                    cwd: None,
                    exit_code: 0,
                    stdout: "".into(),
                    stderr: "".into(),
                });
            }
            Err(e) => {
                steps.push(step_error(format!("mkdir -p {}", lp), e.to_string()));
                return ActionOutcome {
                    ok: false,
                    mode: "local".into(),
                    env_key: "init".into(),
                    action: "init".into(),
                    steps,
                    error: Some(ActionError {
                        severity: "ERROR".into(),
                        code: "GIT-0402".into(),
                        message: "failed to create directory".into(),
                        detail: None,
                    }),
                };
            }
        }
    }

    if dir.join(".git").exists() {
        steps.push(StepResult {
            ok: true,
            cmd: format!("[skip] already initialized: {}", lp),
            cwd: Some(path_to_string(&dir)),
            exit_code: 0,
            stdout: "".into(),
            stderr: "".into(),
        });

        return ActionOutcome {
            ok: true,
            mode: "local".into(),
            env_key: "init".into(),
            action: "init".into(),
            steps,
            error: Some(ActionError {
                severity: "INFO".into(),
                code: "GIT-0403".into(),
                message: ".git already exists (already initialized)".into(),
                detail: None,
            }),
        };
    }

    // git init
    steps.push(run_capture(&git, &["init"], Some(&dir)));

    // default branch（gitバージョン依存を避けるため symbolic-ref を使う）
    let branch = default_branch
        .unwrap_or_else(|| "main".into())
        .trim()
        .to_string();

    if !branch.is_empty() {
        steps.push(run_capture(
            &git,
            &["symbolic-ref", "HEAD", &format!("refs/heads/{}", branch)],
            Some(&dir),
        ));
    }

    // origin設定（repoUrlがあるときだけ）
    if let Some(url) = repo_url {
        let url = url.trim().to_string();
        if !url.is_empty() {
            let rem = run_capture(&git, &["remote"], Some(&dir));
            let has_origin = rem.ok && rem.stdout.lines().any(|l| l.trim() == "origin");
            steps.push(rem);

            if has_origin {
                steps.push(run_capture(
                    &git,
                    &["remote", "set-url", "origin", &url],
                    Some(&dir),
                ));
            } else {
                steps.push(run_capture(
                    &git,
                    &["remote", "add", "origin", &url],
                    Some(&dir),
                ));
            }
        }
    }

    let ok = steps.iter().all(|s| s.ok);

    ActionOutcome {
        ok,
        mode: "local".into(),
        env_key: "init".into(),
        action: "init".into(),
        steps,
        error: if ok {
            None
        } else {
            Some(ActionError {
                severity: "ERROR".into(),
                code: "GIT-0499".into(),
                message: "init failed (see steps)".into(),
                detail: None,
            })
        },
    }
}

// current branch (remote)

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCheck {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightResult {
    platform: String,
    git: ToolCheck,
    ssh: ToolCheck,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StepResult {
    cmd: String,
    cwd: Option<String>,
    ok: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionError {
    code: String,     // e.g. GIT-0201
    severity: String, // INFO/WARN/ERROR/FATAL
    message: String,
    detail: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionOutcome {
    ok: bool,
    mode: String,   // local | ssh
    action: String, // pull | push | merge
    env_key: String,
    steps: Vec<StepResult>,
    error: Option<ActionError>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshConfig {
    host: String,
    user: String,
    port: Option<u16>,
    key_path: Option<String>,
}

fn is_windows() -> bool {
    env::consts::OS == "windows"
}

fn looks_like_path(s: &str) -> bool {
    s.contains('/') || s.contains('\\') || s.contains(':')
}

fn path_to_string(p: &Path) -> String {
    p.to_string_lossy().to_string()
}
// --- After(新規追加) ---
fn strip_wrapping_quotes(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 {
        let first = t.chars().next().unwrap();
        let last = t.chars().last().unwrap();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return t[1..t.len() - 1].trim().to_string();
        }
    }
    t.to_string()
}

fn expand_tilde(s: &str) -> String {
    let t = s.trim();
    if t == "~" || t.starts_with("~/") || t.starts_with("~\\") {
        if let Ok(home) = env::var("HOME") {
            if t == "~" {
                return home;
            }
            let rest = &t[1..]; // keep slash/backslash
            return format!("{}{}", home, rest);
        }
        if let Ok(up) = env::var("USERPROFILE") {
            if t == "~" {
                return up;
            }
            let rest = &t[1..];
            return format!("{}{}", up, rest);
        }
    }
    t.to_string()
}

fn normalize_path_input(s: &str) -> String {
    let x = strip_wrapping_quotes(s);
    expand_tilde(&x)
}

#[tauri::command(rename_all = "camelCase")]
fn default_detect_root() -> String {
    // Windows 優先
    if let Ok(v) = env::var("USERPROFILE") {
        if Path::new(&v).is_dir() {
            return v;
        }
    }
    // Unix系
    if let Ok(v) = env::var("HOME") {
        if Path::new(&v).is_dir() {
            return v;
        }
    }
    // fallback
    if let Ok(v) = env::current_dir() {
        return path_to_string(&v);
    }
    "".into()
}

fn pathexts() -> Vec<String> {
    if !is_windows() {
        return vec![];
    }
    match env::var("PATHEXT") {
        Ok(v) => v
            .split(';')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .collect(),
        Err(_) => vec![".EXE".into(), ".CMD".into(), ".BAT".into(), ".COM".into()],
    }
}

fn find_in_path(cmd: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let exts = pathexts();

    for dir in env::split_paths(&path_var) {
        let p0 = dir.join(cmd);
        if p0.is_file() {
            return Some(p0);
        }

        if is_windows() && Path::new(cmd).extension().is_none() {
            for ext in &exts {
                let candidate = dir.join(format!("{}{}", cmd, ext));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn resolve_executable(
    explicit: Option<String>,
    base_name: &str,
    known_paths: &[&str],
) -> Option<PathBuf> {
    if let Some(s) = explicit {
        let trimmed = s.trim().to_string();
        if !trimmed.is_empty() {
            if looks_like_path(&trimmed) {
                let p = PathBuf::from(&trimmed);
                if p.is_file() {
                    return Some(p);
                }
                if p.is_dir() {
                    let p2 = p.join(base_name);
                    if p2.is_file() {
                        return Some(p2);
                    }
                    if is_windows() {
                        let p3 = p.join(format!("{}.exe", base_name));
                        if p3.is_file() {
                            return Some(p3);
                        }
                    }
                }
            } else if let Some(p) = find_in_path(&trimmed) {
                return Some(p);
            }
        }
    }

    for kp in known_paths {
        let p = PathBuf::from(kp);
        if p.is_file() {
            return Some(p);
        }
    }

    find_in_path(base_name)
}

fn run_capture(exe: &Path, args: &[&str], cwd: Option<&Path>) -> StepResult {
    let mut cmd = Command::new(exe);
    cmd.args(args);

    // 対話プロンプトで固まるのを防ぐ（Gitが認証を要求しても即失敗させる）
    cmd.stdin(Stdio::null());
    cmd.env("GIT_TERMINAL_PROMPT", "0");

    if let Some(d) = cwd {
        cmd.current_dir(d);
    }

    let output = cmd.output();
    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let ok = o.status.success();
            let exit_code = o.status.code().unwrap_or(-1);

            StepResult {
                cmd: format!(
                    "{} {}",
                    exe.display(),
                    args.iter()
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
                cwd: cwd.map(path_to_string),
                ok,
                exit_code,
                stdout,
                stderr,
            }
        }
        Err(e) => StepResult {
            cmd: format!(
                "{} {}",
                exe.display(),
                args.iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
            cwd: cwd.map(path_to_string),
            ok: false,
            exit_code: -1,
            stdout: "".into(),
            stderr: e.to_string(),
        },
    }
}

fn run_version(exe: &Path, args: &[&str]) -> (bool, Option<String>, Option<String>) {
    let step = run_capture(exe, args, None);
    let has_stdout = !step.stdout.trim().is_empty();
    let has_stderr = !step.stderr.trim().is_empty();

    let ver = if has_stdout {
        Some(step.stdout.trim().to_string())
    } else if has_stderr {
        Some(step.stderr.trim().to_string())
    } else {
        None
    };

    let err = if step.ok {
        None
    } else if has_stderr {
        Some(step.stderr.trim().to_string())
    } else if has_stdout {
        Some(step.stdout.trim().to_string())
    } else {
        Some("command failed".into())
    };

    (step.ok, ver, err)
}

fn check_tool(
    explicit: Option<String>,
    base_name: &str,
    known_paths: &[&str],
    version_args: &[&str],
) -> ToolCheck {
    let exe = resolve_executable(explicit, base_name, known_paths);
    match exe {
        Some(p) => {
            let (ok, version, error) = run_version(&p, version_args);
            ToolCheck {
                found: true,
                path: Some(path_to_string(&p)),
                version,
                ok,
                error,
            }
        }
        None => ToolCheck {
            found: false,
            path: None,
            version: None,
            ok: false,
            error: Some(format!("{} not found", base_name)),
        },
    }
}

#[tauri::command(rename_all = "camelCase")]
fn preflight(git_path: Option<String>, ssh_path: Option<String>) -> PreflightResult {
    let git_known: Vec<&str> = if is_windows() {
        vec![
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files\Git\bin\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
            r"C:\Program Files (x86)\Git\bin\git.exe",
        ]
    } else {
        vec![]
    };

    let ssh_known: Vec<&str> = if is_windows() {
        vec![r"C:\Windows\System32\OpenSSH\ssh.exe"]
    } else {
        vec![]
    };

    let git = check_tool(git_path, "git", &git_known, &["--version"]);
    let ssh = check_tool(ssh_path, "ssh", &ssh_known, &["-V"]);

    PreflightResult {
        platform: env::consts::OS.to_string(),
        git,
        ssh,
    }
}

fn repo_is_git_dir(p: &Path) -> bool {
    p.join(".git").exists()
}

fn git_exe(git_path: Option<String>) -> Option<PathBuf> {
    let git_known: Vec<&str> = if is_windows() {
        vec![
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files\Git\bin\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
            r"C:\Program Files (x86)\Git\bin\git.exe",
        ]
    } else {
        vec![]
    };
    resolve_executable(git_path, "git", &git_known)
}

fn ssh_exe(ssh_path: Option<String>) -> Option<PathBuf> {
    let ssh_known: Vec<&str> = if is_windows() {
        vec![r"C:\Windows\System32\OpenSSH\ssh.exe"]
    } else {
        vec![]
    };
    resolve_executable(ssh_path, "ssh", &ssh_known)
}

fn git_status_clean(
    git: &PathBuf,
    repo_dir: &PathBuf,
    steps: &mut Vec<StepResult>,
) -> Result<bool, String> {
    let s = run_capture(
        git,
        &["-C", &path_to_string(repo_dir), "status", "--porcelain", "--ignore-submodules"],
        None,
    );
    steps.push(s.clone());

    if !s.ok {
        return Err(format!("git status failed: {}", s.stderr));
    }

    Ok(s.stdout.trim().is_empty())
}

fn shell_escape_posix_single(s: &str) -> String {
    // ' -> '\'' (POSIX sh)
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn ssh_run(ssh: &Path, cfg: &SshConfig, remote_cmd: &str) -> StepResult {
    let target = format!("{}@{}", cfg.user, cfg.host);
    let port = cfg.port.unwrap_or(22);

    let mut args: Vec<String> = Vec::new();
    args.push("-p".into());
    args.push(port.to_string());
    args.push("-o".into());
    args.push("BatchMode=yes".into());
    args.push("-o".into());
    args.push("ConnectTimeout=5".into());
    args.push("-o".into());
    args.push("ConnectionAttempts=1".into());

    if let Some(k) = &cfg.key_path {
        if !k.trim().is_empty() {
            args.push("-i".into());
            args.push(k.clone());
        }
    }

    args.push(target);
    args.push("--".into());
    args.push(remote_cmd.into());

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_capture(ssh, &arg_refs, None)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchListWire {
    ok: bool,
    branches: Vec<String>,
    stderr: Option<String>,
}

#[tauri::command(rename_all = "camelCase")]
fn list_branches(repo_url: String, git_path: Option<String>) -> BranchListWire {
    let git = match git_exe(git_path) {
        Some(p) => p,
        None => {
            return BranchListWire {
                ok: false,
                branches: vec![],
                stderr: Some("git not found".into()),
            }
        }
    };

    let step = run_capture(&git, &["ls-remote", "--heads", &repo_url], None);

    if !step.ok {
        let msg = if !step.stderr.trim().is_empty() {
            step.stderr
        } else {
            step.stdout
        };
        return BranchListWire {
            ok: false,
            branches: vec![],
            stderr: Some(msg),
        };
    }

    let mut out: Vec<String> = Vec::new();
    for line in step.stdout.lines() {
        // <sha>\trefs/heads/<branch>
        if let Some((_, r)) = line.split_once('\t') {
            if let Some(b) = r.strip_prefix("refs/heads/") {
                let name = b.trim().to_string();
                if !name.is_empty() {
                    out.push(name);
                }
            }
        }
    }
    out.sort();
    out.dedup();

    BranchListWire {
        ok: true,
        branches: out,
        stderr: None,
    }
}

// list_branches の直後に追加

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectedRepo {
    path: String,
    origin_url: Option<String>,
    name: Option<String>,
}

fn should_skip_dir(name: &str) -> bool {
    // speed / noise reduction
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".venv" | ".idea" | ".vscode"
    )
}

fn is_git_repo_dir(dir: &Path) -> bool {
    let git = dir.join(".git");
    git.is_dir() || git.is_file()
}

fn git_remote_origin_url(git: &Path, repo_dir: &Path) -> Option<String> {
    let step = run_capture(
        git,
        &[
            "-C",
            &path_to_string(repo_dir),
            "remote",
            "get-url",
            "origin",
        ],
        None,
    );
    if !step.ok {
        return None;
    }
    let s = step.stdout.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn walk_detect_repos(dir: &Path, depth: u8, max_depth: u8, out: &mut Vec<PathBuf>) {
    if depth > max_depth {
        return;
    }

    let rd = match std::fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };

    for entry in rd.flatten() {
        let ft = match entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }

        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if should_skip_dir(&name) {
            continue;
        }

        let p = entry.path();
        if is_git_repo_dir(&p) {
            out.push(p);
            continue;
        }

        walk_detect_repos(&p, depth + 1, max_depth, out);
    }
}

#[tauri::command(rename_all = "camelCase")]
fn detect_local_repos(
    root_path: String,
    max_depth: u8,
    git_path: Option<String>,
) -> Result<Vec<DetectedRepo>, String> {
    let p = normalize_path_input(&root_path);
    let p = p.trim().to_string();
    if p.is_empty() {
        return Err("root_path is empty".to_string());
    }

    let root = PathBuf::from(&p);
    if !root.exists() {
        return Err(format!(
            "root_path does not exist: {}",
            path_to_string(&root)
        ));
    }
    if !root.is_dir() {
        return Err(format!(
            "root_path is not a directory: {}",
            path_to_string(&root)
        ));
    }

    let md = max_depth.clamp(1, 50);
    let git = git_exe(git_path);

    let mut found: Vec<PathBuf> = Vec::new();

    // root 自体が repo の場合も拾う
    if is_git_repo_dir(&root) {
        found.push(root.clone());
    } else {
        walk_detect_repos(&root, 0, md, &mut found);
    }

    found.sort();
    found.dedup();

    let mut out: Vec<DetectedRepo> = Vec::new();
    for repo_dir in found {
        let name = repo_dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());

        let origin_url = match &git {
            Some(g) => git_remote_origin_url(g, &repo_dir),
            None => None,
        };

        out.push(DetectedRepo {
            path: path_to_string(&repo_dir),
            origin_url,
            name,
        });
    }

    Ok(out)
}

#[tauri::command(rename_all = "camelCase")]
fn detect_remote_repos(
    ssh_path: Option<String>,
    ssh: SshConfig,
    root_path: String,
    max_depth: u8,
    max_repos: u16,
) -> Result<Vec<DetectedRepo>, String> {
    let Some(ssh_exe) = ssh_exe(ssh_path) else {
        return Err("ssh not found. Run preflight and set sshPath if needed.".into());
    };

    if ssh.host.trim().is_empty() || ssh.user.trim().is_empty() {
        return Err("ssh.host / ssh.user is required".into());
    }

    let md = max_depth.clamp(1, 30);
    let mr = max_repos.clamp(1, 5000);

    // root_path が空なら remote の $HOME を使う（SSH先で解決）
    let rp = root_path.trim().to_string();

    // remote側で find して .git を列挙し、repo と origin を拾って TSV で返す
    let remote_script = format!(
        r#"
ROOT={root};
MAXD={md};
MAXR={mr};

if [ -z "$ROOT" ]; then
  ROOT="$HOME";
fi

if ! command -v find >/dev/null 2>&1; then
  echo "find not found" >&2
  exit 4
fi

GIT_BIN=""
if command -v git >/dev/null 2>&1; then
  GIT_BIN="$(command -v git)"
fi

if [ -z "$GIT_BIN" ]; then
  echo "git not found on remote" >&2
  exit 5
fi

count=0
find "$ROOT" -maxdepth "$MAXD" -type d -name .git 2>/dev/null | while IFS= read -r g; do
  repo="${{g%/.git}}"
  name="$(basename "$repo")"
  origin="$("$GIT_BIN" -C "$repo" remote get-url origin 2>/dev/null || true)"
  printf '%s\t%s\t%s\n' "$repo" "$origin" "$name"
  count=$((count+1))
  if [ "$count" -ge "$MAXR" ]; then
    break
  fi
done
"#,
        root = shell_escape_posix_single(&rp),
        md = md,
        mr = mr
    );

    let remote_cmd = format!("sh -c {}", shell_escape_posix_single(&remote_script));
    let step = ssh_run(&ssh_exe, &ssh, &remote_cmd);

    if !step.ok {
        let msg = format!(
            "remote detect failed: exit={} stderr={}",
            step.exit_code, step.stderr
        );
        return Err(msg);
    }

    let mut seen = HashSet::<String>::new();
    let mut out = Vec::<DetectedRepo>::new();

    for line in step.stdout.lines() {
        let ln = line.trim();
        if ln.is_empty() {
            continue;
        }

        let mut parts = ln.splitn(3, '\t');
        let path = parts.next().unwrap_or("").trim().to_string();
        if path.is_empty() {
            continue;
        }
        if !seen.insert(path.clone()) {
            continue;
        }

        let origin = parts.next().unwrap_or("").trim();
        let name = parts.next().unwrap_or("").trim();

        out.push(DetectedRepo {
            path,
            origin_url: if origin.is_empty() {
                None
            } else {
                Some(origin.to_string())
            },
            name: if name.is_empty() {
                None
            } else {
                Some(name.to_string())
            },
        });
    }

    Ok(out)
}

fn step_error(cmd: String, stderr: String) -> StepResult {
    StepResult {
        cmd,
        cwd: None,
        ok: false,
        exit_code: -1,
        stdout: "".into(),
        stderr,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectWire {
    // 「SSHもgitもOK」＝ ready
    ok: bool,
    // SSH疎通だけはOK（gitがNGのケースをUIで出せるように）
    ssh_ok: bool,
    stderr: Option<String>,
    remote_git: ToolCheck,
}

fn ssh_detect_remote_git(ssh_exe: &Path, cfg: &SshConfig) -> ToolCheck {
    // 非対話シェルでPATHが薄い環境があるので、
    // command -v -> 典型パスの順にフォールバックして「実行可能なgit」を探す。
    let script = "\
if command -v git >/dev/null 2>&1; then command -v git; \
elif [ -x /usr/bin/git ]; then echo /usr/bin/git; \
elif [ -x /usr/local/bin/git ]; then echo /usr/local/bin/git; \
elif [ -x /bin/git ]; then echo /bin/git; \
else echo; fi";

    let find_cmd = format!("sh -c {}", shell_escape_posix_single(script));
    let find = ssh_run(ssh_exe, cfg, &find_cmd);

    if !find.ok {
        let msg = if !find.stderr.trim().is_empty() {
            find.stderr
        } else {
            find.stdout
        };
        return ToolCheck {
            found: false,
            path: None,
            version: None,
            ok: false,
            error: Some(msg),
        };
    }

    let path = find.stdout.lines().next().unwrap_or("").trim().to_string();

    if path.is_empty() {
        return ToolCheck {
            found: false,
            path: None,
            version: None,
            ok: false,
            error: Some("git not found on remote (PATH or standard locations)".into()),
        };
    }

    let ver_cmd = format!("{} --version", shell_escape_posix_single(&path));
    let ver = ssh_run(ssh_exe, cfg, &ver_cmd);

    if !ver.ok {
        let msg = if !ver.stderr.trim().is_empty() {
            ver.stderr
        } else {
            ver.stdout
        };
        return ToolCheck {
            found: true,
            path: Some(path),
            version: None,
            ok: false,
            error: Some(msg),
        };
    }

    ToolCheck {
        found: true,
        path: Some(path),
        version: Some(ver.stdout.trim().to_string()),
        ok: true,
        error: None,
    }
}

#[tauri::command(rename_all = "camelCase")]
fn ssh_connect(ssh_path: Option<String>, ssh: SshConfig) -> SshConnectWire {
    let Some(ssh_exe) = ssh_exe(ssh_path) else {
        return SshConnectWire {
            ok: false,
            ssh_ok: false,
            stderr: Some("ssh not found. preflight required".into()),
            remote_git: ToolCheck {
                found: false,
                path: None,
                version: None,
                ok: false,
                error: Some("remote git not checked".into()),
            },
        };
    };

    if ssh.host.trim().is_empty() || ssh.user.trim().is_empty() {
        return SshConnectWire {
            ok: false,
            ssh_ok: false,
            stderr: Some("host/user is required".into()),
            remote_git: ToolCheck {
                found: false,
                path: None,
                version: None,
                ok: false,
                error: Some("remote git not checked".into()),
            },
        };
    }

    // 1) SSH疎通（echo）
    let ping = ssh_run(&ssh_exe, &ssh, "echo GITSHLC_SSH_OK");
    let ssh_ok = ping.ok && ping.stdout.contains("GITSHLC_SSH_OK");

    if !ssh_ok {
        let msg = if !ping.stderr.trim().is_empty() {
            ping.stderr
        } else {
            ping.stdout
        };

        return SshConnectWire {
            ok: false,
            ssh_ok: false,
            stderr: Some(msg),
            remote_git: ToolCheck {
                found: false,
                path: None,
                version: None,
                ok: false,
                error: Some("remote git not checked".into()),
            },
        };
    }

    // 2) remote git検知
    let remote_git = ssh_detect_remote_git(&ssh_exe, &ssh);

    // 「ready」は ssh + remote git 両方OK
    let ok = ssh_ok && remote_git.ok;
    let stderr = if ok { None } else { remote_git.error.clone() };

    SshConnectWire {
        ok,
        ssh_ok,
        stderr,
        remote_git,
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunActionRequest {
    mode: String,
    env_key: String,
    action: String,
    local_path: String,
    remote_path: String,
    branch: String,
    git_path: String,
    ssh_path: String,
    ssh: SshConfig,
    merge_from_branch: Option<String>,
    commit_message: Option<String>,
}

#[tauri::command(rename_all = "camelCase")]
fn run_action(req: RunActionRequest) -> ActionOutcome {
    let mut steps: Vec<StepResult> = Vec::new();

    let fail = |code: &str,
                severity: &str,
                message: &str,
                detail: Option<String>,
                steps: Vec<StepResult>,
                req: &RunActionRequest| {
        ActionOutcome {
            ok: false,
            mode: req.mode.clone(),
            action: req.action.clone(),
            env_key: req.env_key.clone(),
            steps,
            error: Some(ActionError {
                code: code.into(),
                severity: severity.into(),
                message: message.into(),
                detail,
            }),
        }
    };

    if req.action != "pull" && req.action != "push" && req.action != "merge" {
        return fail(
            "CFG-0001",
            "ERROR",
            "unknown action",
            Some(req.action.clone()),
            steps,
            &req,
        );
    }

    if req.mode == "local" {
        let git = match git_exe(if req.git_path.trim().is_empty() {
            None
        } else {
            Some(req.git_path.clone())
        }) {
            Some(p) => p,
            None => {
                return fail("GIT-0001", "FATAL", "git not found", None, steps, &req);
            }
        };

        let lp = req.local_path.trim();
        if lp.is_empty() {
            return fail(
                "FS-0100",
                "ERROR",
                "localPath is required",
                None,
                steps,
                &req,
            );
        }

        let local_path = PathBuf::from(lp);
        if !local_path.exists() {
            return fail(
                "FS-0101",
                "ERROR",
                "localPath does not exist",
                Some(path_to_string(&local_path)),
                steps,
                &req,
            );
        }
        if !local_path.is_dir() {
            return fail(
                "FS-0101",
                "ERROR",
                "localPath is not a directory",
                Some(path_to_string(&local_path)),
                steps,
                &req,
            );
        }
        if !repo_is_git_dir(&local_path) {
            return fail(
                "FS-0102",
                "ERROR",
                "localPath is not a git repository",
                Some(path_to_string(&local_path)),
                steps,
                &req,
            );
        }

        // current branch (unborn branchでも取れるように symbolic-ref)
        let br_step = run_capture(
            &git,
            &[
                "-C",
                &path_to_string(&local_path),
                "symbolic-ref",
                "--short",
                "HEAD",
            ],
            None,
        );
        let current_branch = br_step.stdout.trim().to_string();
        if !br_step.ok {
            let detail = Some(br_step.stderr.clone());
            steps.push(br_step);
            return fail(
                "GIT-0100",
                "ERROR",
                "failed to get current branch",
                detail,
                steps,
                &req,
            );
        }

        // HEAD exists?（初回pushのrefspec事故回避）
        let head_step = run_capture(
            &git,
            &[
                "-C",
                &path_to_string(&local_path),
                "rev-parse",
                "--verify",
                "HEAD",
            ],
            None,
        );
        let mut has_commits = head_step.ok;
        steps.push(head_step);
        steps.push(br_step);

        // clean check
        let clean = match git_status_clean(&git, &local_path, &mut steps) {
            Ok(v) => v,
            Err(e) => {
                return fail(
                    "GIT-0101",
                    "ERROR",
                    "git status failed",
                    Some(e),
                    steps,
                    &req,
                )
            }
        };

        // For pull/merge: auto-stash if dirty (ignore local changes)
        if req.action != "push" && !clean {
            let mut stash_step = run_capture(
                &git,
                &["-C", &path_to_string(&local_path), "stash", "--include-untracked"],
                None,
            );
            // Mark stash as OK if it saved changes (even with permission errors)
            if stash_step.stdout.contains("Saved working directory") {
                stash_step.ok = true;
            }
            steps.push(stash_step);
        }

        // dirtyなら push 前に commit を作る（commitMessage 必須）
        if req.action == "push" && !clean {
            if current_branch != req.branch {
                return fail(
                    "GIT-0103",
                    "ERROR",
                    "working tree is dirty on a different branch",
                    Some(format!(
                        "current_branch={} target_branch={}",
                        current_branch, req.branch
                    )),
                    steps,
                    &req,
                );
            }

            let msg = req.commit_message.clone().unwrap_or_default();
            let msg = msg.trim().to_string();
            if msg.is_empty() {
                return fail(
                    "GIT-0104",
                    "ERROR",
                    "push requires commitMessage when working tree is dirty",
                    None,
                    steps,
                    &req,
                );
            }

            let add_step = run_capture(
                &git,
                &["-C", &path_to_string(&local_path), "add", "-A"],
                None,
            );
            if !add_step.ok {
                let detail = Some(add_step.stderr.clone());
                steps.push(add_step);
                return fail("GIT-0105", "ERROR", "git add failed", detail, steps, &req);
            }
            steps.push(add_step);

            let commit_step = run_capture(
                &git,
                &["-C", &path_to_string(&local_path), "commit", "-m", &msg],
                None,
            );
            if !commit_step.ok {
                let detail = Some(commit_step.stderr.clone());
                steps.push(commit_step);
                return fail(
                    "GIT-0106",
                    "ERROR",
                    "git commit failed",
                    detail,
                    steps,
                    &req,
                );
            }
            steps.push(commit_step);
            has_commits = true;
        }

        // fetch
        steps.push(run_capture(
            &git,
            &["-C", &path_to_string(&local_path), "fetch", "origin"],
            None,
        ));

        // checkout branch
        steps.push(run_capture(
            &git,
            &["-C", &path_to_string(&local_path), "checkout", &req.branch],
            None,
        ));

        // 初回 push のために、コミットが無い場合は --allow-empty で 1つ作る
        if req.action == "push" && !has_commits {
            let msg = req.commit_message.clone().unwrap_or_default();
            let msg = msg.trim().to_string();
            if msg.is_empty() {
                return fail(
                    "GIT-0107",
                    "ERROR",
                    "push requires commitMessage when repository has no commits",
                    None,
                    steps,
                    &req,
                );
            }

            let empty_commit = run_capture(
                &git,
                &[
                    "-C",
                    &path_to_string(&local_path),
                    "commit",
                    "--allow-empty",
                    "-m",
                    &msg,
                ],
                None,
            );
            if !empty_commit.ok {
                let detail = Some(empty_commit.stderr.clone());
                steps.push(empty_commit);
                return fail(
                    "GIT-0108",
                    "ERROR",
                    "git commit --allow-empty failed",
                    detail,
                    steps,
                    &req,
                );
            }
            steps.push(empty_commit);
            has_commits = true;
        }

        if req.action == "pull" {
            steps.push(run_capture(
                &git,
                &[
                    "-C",
                    &path_to_string(&local_path),
                    "pull",
                    "--ff-only",
                    "origin",
                    &req.branch,
                ],
                None,
            ));
        }

        if req.action == "push" {
            steps.push(run_capture(
                &git,
                &[
                    "-C",
                    &path_to_string(&local_path),
                    "push",
                    "origin",
                    &req.branch,
                ],
                None,
            ));
        }

        if req.action == "merge" {
            let from = req.merge_from_branch.clone().unwrap_or_default();
            if from.trim().is_empty() {
                return fail(
                    "CFG-0003",
                    "ERROR",
                    "mergeFromBranch is required for merge",
                    None,
                    steps,
                    &req,
                );
            }

            steps.push(run_capture(
                &git,
                &["-C", &path_to_string(&local_path), "fetch", "origin", &from],
                None,
            ));

            steps.push(run_capture(
                &git,
                &[
                    "-C",
                    &path_to_string(&local_path),
                    "merge",
                    "--no-ff",
                    &from,
                ],
                None,
            ));

            steps.push(run_capture(
                &git,
                &[
                    "-C",
                    &path_to_string(&local_path),
                    "push",
                    "origin",
                    &req.branch,
                ],
                None,
            ));
        }

        let ok = steps.iter().all(|s| s.ok);
        return ActionOutcome {
            ok,
            mode: req.mode.clone(),
            action: req.action.clone(),
            env_key: req.env_key.clone(),
            steps,
            error: if ok {
                None
            } else {
                Some(ActionError {
                    code: "GIT-0002".into(),
                    severity: "ERROR".into(),
                    message: "git command failed".into(),
                    detail: None,
                })
            },
        };
    }

    if req.mode == "ssh" {
        let ssh = match ssh_exe(if req.ssh_path.trim().is_empty() {
            None
        } else {
            Some(req.ssh_path.clone())
        }) {
            Some(p) => p,
            None => return fail("SSH-0001", "FATAL", "ssh not found", None, steps, &req),
        };

        let cfg = req.ssh.clone();
        if cfg.host.trim().is_empty() || cfg.user.trim().is_empty() {
            return fail(
                "CFG-0302",
                "ERROR",
                "ssh host/user is required",
                None,
                steps,
                &req,
            );
        }

        let remote_path = req.remote_path.trim().to_string();
        if remote_path.is_empty() {
            return fail(
                "CFG-0303",
                "ERROR",
                "remotePath is required",
                None,
                steps,
                &req,
            );
        }

        // current branch（unborn/detachedにも少し強くする）
        let br_cmd = format!(
            "cd {} && (git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD)",
            shell_escape_posix_single(&remote_path)
        );
        let br_step = ssh_run(&ssh, &cfg, &br_cmd);
        let current_branch = br_step.stdout.trim().to_string();
        if !br_step.ok {
            let detail = Some(br_step.stderr.clone());
            steps.push(br_step);
            return fail(
                "SSH-0201",
                "ERROR",
                "failed to get remote branch",
                detail,
                steps,
                &req,
            );
        }
        steps.push(br_step);

        // HEAD exists?（初回pushのrefspec事故回避）
        let head_cmd = format!(
            "cd {} && git rev-parse --verify HEAD",
            shell_escape_posix_single(&remote_path)
        );
        let head_step = ssh_run(&ssh, &cfg, &head_cmd);
        let mut has_commits = head_step.ok;
        steps.push(head_step);

        // status (ignore submodules to avoid false positives from nested repos)
        let status_cmd = format!(
            "cd {} && git status --porcelain --ignore-submodules",
            shell_escape_posix_single(&remote_path)
        );
        let st_step = ssh_run(&ssh, &cfg, &status_cmd);
        if !st_step.ok {
            let detail = Some(st_step.stderr.clone());
            steps.push(st_step);
            return fail(
                "SSH-0201",
                "ERROR",
                "git status failed on remote",
                detail,
                steps,
                &req,
            );
        }
        let clean = st_step.stdout.trim().is_empty();
        steps.push(st_step);

        // For pull/merge: auto-stash if dirty (ignore local changes)
        if req.action != "push" && !clean {
            let stash_cmd = format!(
                "cd {} && git stash --include-untracked",
                shell_escape_posix_single(&remote_path)
            );
            let mut stash_step = ssh_run(&ssh, &cfg, &stash_cmd);
            // Mark stash as OK if it saved changes (even with permission errors)
            if stash_step.stdout.contains("Saved working directory") {
                stash_step.ok = true;
            }
            steps.push(stash_step);
        }

        // push & dirty => commitMessage必須で add+commit
        if req.action == "push" && !clean {
            if current_branch != req.branch {
                return fail(
                    "GIT-0104",
                    "ERROR",
                    "working tree is dirty on a non-target branch (checkout target branch first)",
                    Some(format!("current={}, target={}", current_branch, req.branch)),
                    steps,
                    &req,
                );
            }

            let msg = req.commit_message.clone().unwrap_or_default();
            let msg = msg.trim().to_string();
            if msg.is_empty() {
                return fail(
                    "GIT-0103",
                    "ERROR",
                    "commitMessage is required for push when there are uncommitted changes",
                    None,
                    steps,
                    &req,
                );
            }

            let add_cmd = format!(
                "cd {} && git add -A",
                shell_escape_posix_single(&remote_path)
            );
            let add_step = ssh_run(&ssh, &cfg, &add_cmd);
            if !add_step.ok {
                let detail = Some(add_step.stderr.clone());
                steps.push(add_step);
                return fail(
                    "SSH-0201",
                    "ERROR",
                    "git add failed on remote",
                    detail,
                    steps,
                    &req,
                );
            }
            steps.push(add_step);

            let commit_cmd = format!(
                "cd {} && git commit -m {}",
                shell_escape_posix_single(&remote_path),
                shell_escape_posix_single(&msg)
            );
            let commit_step = ssh_run(&ssh, &cfg, &commit_cmd);
            if !commit_step.ok {
                let detail = Some(commit_step.stderr.clone());
                steps.push(commit_step);
                return fail(
                    "SSH-0201",
                    "ERROR",
                    "git commit failed on remote",
                    detail,
                    steps,
                    &req,
                );
            }
            steps.push(commit_step);
            has_commits = true;
        }

        // 初回 push（コミット 0 件）なら allow-empty で 1件作る
        if req.action == "push" && !has_commits {
            let msg = req.commit_message.clone().unwrap_or_default();
            let msg = msg.trim().to_string();
            if msg.is_empty() {
                return fail(
                    "GIT-0107",
                    "ERROR",
                    "push requires commitMessage when repository has no commits",
                    None,
                    steps,
                    &req,
                );
            }

            let empty_commit_cmd = format!(
                "cd {} && git commit --allow-empty -m {}",
                shell_escape_posix_single(&remote_path),
                shell_escape_posix_single(&msg)
            );
            let empty_commit_step = ssh_run(&ssh, &cfg, &empty_commit_cmd);
            if !empty_commit_step.ok {
                let detail = Some(empty_commit_step.stderr.clone());
                steps.push(empty_commit_step);
                return fail(
                    "SSH-0201",
                    "ERROR",
                    "git commit --allow-empty failed on remote",
                    detail,
                    steps,
                    &req,
                );
            }
            steps.push(empty_commit_step);
            has_commits = true;
        }

        // fetch
        let fetch_cmd = format!(
            "cd {} && git fetch origin",
            shell_escape_posix_single(&remote_path)
        );
        steps.push(ssh_run(&ssh, &cfg, &fetch_cmd));

        // checkout
        let checkout_cmd = format!(
            "cd {} && git checkout {}",
            shell_escape_posix_single(&remote_path),
            shell_escape_posix_single(&req.branch)
        );
        steps.push(ssh_run(&ssh, &cfg, &checkout_cmd));

        if req.action == "pull" {
            let pull_cmd = format!(
                "cd {} && git pull --ff-only origin {}",
                shell_escape_posix_single(&remote_path),
                shell_escape_posix_single(&req.branch)
            );
            steps.push(ssh_run(&ssh, &cfg, &pull_cmd));
        }

        if req.action == "push" {
            let push_cmd = format!(
                "cd {} && git push origin {}",
                shell_escape_posix_single(&remote_path),
                shell_escape_posix_single(&req.branch)
            );
            steps.push(ssh_run(&ssh, &cfg, &push_cmd));
        }

        if req.action == "merge" {
            let from = req.merge_from_branch.clone().unwrap_or_default();
            let from = from.trim().to_string();
            if from.is_empty() {
                return fail(
                    "CFG-0201",
                    "ERROR",
                    "mergeFromBranch is required for merge",
                    None,
                    steps,
                    &req,
                );
            }

            let fetch_from_cmd = format!(
                "cd {} && git fetch origin {}",
                shell_escape_posix_single(&remote_path),
                shell_escape_posix_single(&from)
            );
            steps.push(ssh_run(&ssh, &cfg, &fetch_from_cmd));

            let origin_from = format!("origin/{}", from);
            let merge_cmd = format!(
                "cd {} && git merge --no-ff {}",
                shell_escape_posix_single(&remote_path),
                shell_escape_posix_single(&origin_from)
            );
            steps.push(ssh_run(&ssh, &cfg, &merge_cmd));

            let push_after_merge_cmd = format!(
                "cd {} && git push origin {}",
                shell_escape_posix_single(&remote_path),
                shell_escape_posix_single(&req.branch)
            );
            steps.push(ssh_run(&ssh, &cfg, &push_after_merge_cmd));
        }

        let ok = steps.iter().all(|s| s.ok);
        return ActionOutcome {
            ok,
            mode: req.mode.clone(),
            action: req.action.clone(),
            env_key: req.env_key.clone(),
            steps,
            error: if ok {
                None
            } else {
                Some(ActionError {
                    code: "SSH-0200".into(),
                    severity: "ERROR".into(),
                    message: "remote command failed".into(),
                    detail: None,
                })
            },
        };
    }

    fail(
        "CFG-0002",
        "ERROR",
        "unknown mode (expected local|ssh)",
        Some(req.mode.clone()),
        steps,
        &req,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            preflight,
            list_branches,
            ssh_connect,
            default_detect_root,
            detect_local_repos,
            detect_remote_repos,
            init_local_repo,
            run_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
