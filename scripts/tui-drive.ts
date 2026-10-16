// Drive the TUI in a pseudo-terminal and dump what it printed.
// Usage: bun scripts/tui-drive.ts <project-dir> <step>...   step = text | <wait:ms> | <enter> | <esc> | <tab> | <s-tab> | <down> | <up> | <right>
const [dir, ...steps] = process.argv.slice(2);
const KEYS: Record<string, string> = { "<enter>": "\r", "<esc>": "\x1b", "<tab>": "\t", "<s-tab>": "\x1b[Z", "<down>": "\x1b[B", "<up>": "\x1b[A", "<right>": "\x1b[C", "<ctrl-c>": "\x03" };

const cli = new URL("../src/cli.tsx", import.meta.url).pathname;
const proc = Bun.spawn(["script", "-qfec", `stty cols 140 rows 50; bun ${cli} ${dir} ${process.env.SYZ_ARGS ?? ""}`, "/dev/null"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "0" },
});
let out = "";
(async () => {
  for await (const c of proc.stdout) out += new TextDecoder().decode(c);
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);
for (const s of steps) {
  const wait = s.match(/^<wait:(\d+)>$/);
  if (wait) await sleep(Number(wait[1]));
  else {
    proc.stdin.write(KEYS[s] ?? s);
    proc.stdin.flush();
    await sleep(400);
  }
}
await sleep(800);
proc.stdin.write("\x03");
proc.stdin.flush();
await Promise.race([proc.exited, sleep(5000)]);
proc.kill();

// strip ANSI and show the tail of the output
const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]/g, "").replace(/\r/g, "");
console.log(plain.split("\n").filter((l) => l.trim()).slice(-60).join("\n"));
