// Runs the server in the background and at login, with what the OS has:
// a systemd user unit on Linux, a launchd agent on macOS. No root needed.
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { type Config, ENV_PREFIX } from "./config";
import { NAME } from "./name";

/** The command that runs this program: the compiled binary, or bun with the CLI source. */
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Z]:\\~BUN\\/.test(Bun.main);
  return compiled ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "cli.ts")];
}

/** Where the CLI reaches the server; an IPv6 host goes in brackets. */
export function localUrl(c: Config): string {
  const host = c.host === "0.0.0.0" || c.host === "::" ? "127.0.0.1" : c.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${c.port}`;
}

/** The server's /api/health: its JSON, `{ ok: false, status }` for another answer, or null when nothing answers. */
export async function health(c: Config): Promise<any | null> {
  try {
    const res = await fetch(`${localUrl(c)}/api/health`, {
      headers: { Authorization: `Bearer ${c.adminToken}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.json() : { ok: false, status: res.status };
  } catch {
    return null;
  }
}

async function sh(cmd: string[], opts: { quiet?: boolean; ok?: boolean } = {}): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: opts.quiet ? "ignore" : "inherit", stderr: opts.quiet ? "ignore" : "inherit" });
  const code = await proc.exited;
  if (code !== 0 && !opts.ok) throw new Error(`${cmd.join(" ")} exited with ${code}`);
  return code;
}

interface Service {
  file: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Prints the state; returns the exit code (0 when running). */
  status(): Promise<number>;
  logs(follow: boolean, lines?: number): Promise<void>;
}

/** The user manager's own config folder: it may not be this shell's XDG_CONFIG_HOME or HOME. */
function systemdUserDir(): string {
  const p = Bun.spawnSync(["systemctl", "--user", "show-environment"], { stdout: "pipe", stderr: "ignore" });
  const env = Object.fromEntries(
    p.stdout
      .toString()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "systemd", "user");
}

function systemd(config: Config): Service {
  const name = config.serviceName;
  const dir = systemdUserDir();
  const file = join(dir, `${name}.service`);
  const ctl = (...a: string[]) => sh(["systemctl", "--user", ...a]);
  const quote = (s: string) => (/[\s"\\]/.test(s) ? JSON.stringify(s) : s);
  const logs = (follow: boolean, lines = 200) =>
    sh(["journalctl", "--user", "-u", name, "-n", String(lines), "--no-pager", ...(follow ? ["-f"] : [])], { ok: true }).then(() => {});
  const svc: Service = {
    file,
    async install() {
      mkdirSync(dir, { recursive: true });
      const unit = [
        "[Unit]",
        `Description=${NAME}: shared memory for agents`,
        // Give up after 5 failed starts in a minute (a taken port, a broken config) instead of restarting forever.
        "StartLimitIntervalSec=60",
        "StartLimitBurst=5",
        "",
        "[Service]",
        `ExecStart=${[...selfCommand(), "serve"].map(quote).join(" ")}`,
        `Environment=${quote(`${ENV_PREFIX}CONFIG_FILE=${config.configFile}`)}`,
        "Restart=on-failure",
        "RestartSec=3",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n");
      writeFileSync(file, unit);
      await ctl("daemon-reload");
      await ctl("enable", "--quiet", name);
      await ctl("reset-failed", name).catch(() => {});
      await ctl("restart", name); // a re-install runs the new unit and binary
      await running(config, svc);
      // Without linger, user services stop at logout; this is the user's choice to make.
      const user = userInfo().username;
      const linger = Bun.spawnSync(["loginctl", "show-user", user, "-p", "Linger", "--value"], { stdout: "pipe", stderr: "ignore" });
      if (linger.stdout.toString().trim() !== "yes") console.log(`To keep it running when you are logged out: loginctl enable-linger ${user}`);
    },
    async uninstall() {
      await sh(["systemctl", "--user", "disable", "--now", name], { ok: true, quiet: true });
      rmSync(file, { force: true });
      await ctl("daemon-reload");
      await sh(["systemctl", "--user", "reset-failed", name], { ok: true, quiet: true });
    },
    async start() {
      await sh(["systemctl", "--user", "reset-failed", name], { ok: true, quiet: true });
      await ctl("start", name);
      await running(config, svc);
    },
    stop: () => ctl("stop", name).then(() => {}),
    async restart() {
      await sh(["systemctl", "--user", "reset-failed", name], { ok: true, quiet: true });
      await ctl("restart", name);
      await running(config, svc);
    },
    status: () => sh(["systemctl", "--user", "status", "--no-pager", name], { ok: true }),
    logs,
  };
  return svc;
}

function launchd(config: Config): Service {
  const label = config.serviceName;
  const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const log = join(homedir(), "Library", "Logs", `${label}.log`);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const loaded = async () => (await sh(["launchctl", "print", `${domain}/${label}`], { ok: true, quiet: true })) === 0;
  // launchd never rotates the log; keep one older file when it passes 10 MB.
  const rotate = () => {
    try {
      if (statSync(log).size > 10 * 1024 * 1024) renameSync(log, `${log}.1`);
    } catch {}
  };
  // Right after a bootout, launchd may still be tearing the old job down ("Bootstrap failed: 5").
  const bootstrap = async () => {
    for (let i = 0; i < 10; i++) {
      if ((await sh(["launchctl", "bootstrap", domain, file], { ok: true, quiet: true })) === 0) return;
      await Bun.sleep(500);
    }
    await sh(["launchctl", "bootstrap", domain, file]);
  };
  const start = async () => {
    rotate();
    if (await loaded()) await sh(["launchctl", "kickstart", `${domain}/${label}`]);
    else await bootstrap();
    await running(config, svc);
  };
  const stop = async () => {
    if (await loaded()) await sh(["launchctl", "bootout", `${domain}/${label}`]);
  };
  const svc: Service = {
    file,
    async install() {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(join(homedir(), "Library", "Logs"), { recursive: true });
      const args = [...selfCommand(), "serve"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
      writeFileSync(
        file,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${ENV_PREFIX}CONFIG_FILE</key>
    <string>${xml(config.configFile)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`,
      );
      await stop();
      rotate();
      await bootstrap();
      await running(config, svc);
    },
    async uninstall() {
      await stop();
      rmSync(file, { force: true });
    },
    start,
    stop,
    async restart() {
      if (!(await loaded())) return start();
      rotate();
      await sh(["launchctl", "kickstart", "-k", `${domain}/${label}`]);
      await running(config, svc);
    },
    async status() {
      if (!(await loaded())) {
        console.log(`${label}: not running`);
        return 3;
      }
      return sh(["launchctl", "print", `${domain}/${label}`], { ok: true });
    },
    logs: (follow, lines = 200) => sh(["tail", "-n", String(lines), ...(follow ? ["-f"] : []), log], { ok: true }).then(() => {}),
  };
  return svc;
}

/** Waits for the service's server to answer; if it does not, shows its last log lines and fails. */
async function running(config: Config, svc: Service, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await health(config))?.ok) return;
    await Bun.sleep(250);
  }
  console.error(`The service did not answer at ${localUrl(config)} within ${ms / 1000} s. Its last log lines:\n`);
  await svc.logs(false, 20);
  throw new Error(`\nThe service is not running. See ${NAME} service logs.`);
}

export function service(config: Config): Service {
  if (process.platform === "linux") return systemd(config);
  if (process.platform === "darwin") return launchd(config);
  throw new Error(`"service" supports Linux (systemd) and macOS (launchd); on ${process.platform}, run "${NAME} serve" yourself.`);
}

export function serviceInstalled(config: Config): boolean {
  try {
    return existsSync(service(config).file);
  } catch {
    return false;
  }
}
