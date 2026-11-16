// Runs the server in the background and at login, with what the OS has:
// a systemd user unit on Linux, a launchd agent on macOS. No root needed.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "./config";
import { NAME } from "./name";

/** The command that runs this program: the compiled binary, or bun with the CLI source. */
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Z]:\\~BUN\\/.test(Bun.main);
  return compiled ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "cli.ts")];
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
  status(): Promise<void>;
  logs(follow: boolean): Promise<void>;
}

function systemd(config: Config): Service {
  const name = config.serviceName;
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
  const file = join(dir, `${name}.service`);
  const ctl = (...a: string[]) => sh(["systemctl", "--user", ...a]);
  const quote = (s: string) => (/[\s"\\]/.test(s) ? JSON.stringify(s) : s);
  return {
    file,
    async install() {
      mkdirSync(dir, { recursive: true });
      const unit = [
        "[Unit]",
        `Description=${NAME}: shared memory for agents`,
        "After=network.target",
        "",
        "[Service]",
        `ExecStart=${[...selfCommand(), "serve"].map(quote).join(" ")}`,
        `Environment=${quote(`CONFIG_FILE=${config.configFile}`)}`,
        "Restart=on-failure",
        "RestartSec=3",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n");
      writeFileSync(file, unit);
      await ctl("daemon-reload");
      await ctl("enable", "--now", name);
      // Without linger, user services stop at logout; this is the user's choice to make.
      console.log(`To keep it running when you are logged out: loginctl enable-linger ${userInfo().username}`);
    },
    async uninstall() {
      await sh(["systemctl", "--user", "disable", "--now", name], { ok: true, quiet: true });
      rmSync(file, { force: true });
      await ctl("daemon-reload");
    },
    start: () => ctl("start", name).then(() => {}),
    stop: () => ctl("stop", name).then(() => {}),
    restart: () => ctl("restart", name).then(() => {}),
    status: () => sh(["systemctl", "--user", "status", "--no-pager", name], { ok: true }).then(() => {}),
    logs: (follow) =>
      sh(["journalctl", "--user", "-u", name, "-n", "200", "--no-pager", ...(follow ? ["-f"] : [])], { ok: true }).then(() => {}),
  };
}

function launchd(config: Config): Service {
  const label = config.serviceName;
  const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const log = join(homedir(), "Library", "Logs", `${label}.log`);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const loaded = async () => (await sh(["launchctl", "print", `${domain}/${label}`], { ok: true, quiet: true })) === 0;
  const start = async () => {
    if (await loaded()) await sh(["launchctl", "kickstart", `${domain}/${label}`]);
    else await sh(["launchctl", "bootstrap", domain, file]);
  };
  const stop = async () => {
    if (await loaded()) await sh(["launchctl", "bootout", `${domain}/${label}`]);
  };
  return {
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
    <key>CONFIG_FILE</key>
    <string>${xml(config.configFile)}</string>
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
      await sh(["launchctl", "bootstrap", domain, file]);
    },
    async uninstall() {
      await stop();
      rmSync(file, { force: true });
    },
    start,
    stop,
    async restart() {
      if (await loaded()) await sh(["launchctl", "kickstart", "-k", `${domain}/${label}`]);
      else await start();
    },
    async status() {
      if (!(await loaded())) return console.log(`${label}: not running`);
      await sh(["launchctl", "print", `${domain}/${label}`], { ok: true });
    },
    logs: (follow) => sh(["tail", "-n", "200", ...(follow ? ["-f"] : []), log], { ok: true }).then(() => {}),
  };
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
