// Windows 10/11 (x64). Uses bun:ffi for what Windows only exposes through Win32: process working directories (PEB),
// memory status, and Job Objects for memory caps.
import { setPriority } from "node:os";
import { join } from "node:path";
import { run, runInherit } from "../core/run.ts";
import { HOME } from "../core/util.ts";
import type { Platform, Proc } from "./types.ts";

const ps = (script: string) => run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);

let k32: any, ntdll: any, ffiPtr: any;
function ffi() {
  if (k32) return;
  const { dlopen, FFIType, ptr } = require("bun:ffi");
  ffiPtr = ptr;
  k32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    ReadProcessMemory: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    GlobalMemoryStatusEx: { args: [FFIType.ptr], returns: FFIType.bool },
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
  }).symbols;
  ntdll = dlopen("ntdll.dll", {
    NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

/** MEMORYSTATUSEX (64 bytes): ullAvailPhys @16, ullTotalPageFile @24 (commit limit), ullAvailPageFile @32. */
function memStatus() {
  ffi();
  const b = new Uint8Array(64), dv = new DataView(b.buffer);
  dv.setUint32(0, 64, true);
  if (!k32.GlobalMemoryStatusEx(ffiPtr(b))) return null;
  const mb = (o: number) => Number(dv.getBigUint64(o, true) / 1048576n);
  return { availPhys: mb(16), commitLimit: mb(24), commitAvail: mb(32) };
}

/** Working directory of another process: PEB → ProcessParameters (+0x20) → CurrentDirectory.DosPath (+0x38). x64 only. */
function cwdOf(pid: number): string | null {
  const h = k32.OpenProcess(0x0410, false, pid); // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
  if (!h) return null;
  try {
    const pbi = new BigUint64Array(6);
    if (ntdll.NtQueryInformationProcess(h, 0, ffiPtr(pbi), 48, null) !== 0) return null;
    const read = (addr: bigint, n: number) => {
      const b = new Uint8Array(n);
      return k32.ReadProcessMemory(h, addr, ffiPtr(b), n, null) ? b : null;
    };
    const pp = read(pbi[1] + 0x20n, 8);
    if (!pp) return null;
    const us = read(new DataView(pp.buffer).getBigUint64(0, true) + 0x38n, 16);
    if (!us) return null;
    const dv = new DataView(us.buffer);
    const s = read(dv.getBigUint64(8, true), dv.getUint16(0, true));
    return s ? new TextDecoder("utf-16le").decode(s) : null;
  } finally {
    k32.CloseHandle(h);
  }
}

/** Put THIS process in a job with a memory limit before spawning: children inherit the job, so nothing escapes the cap. */
function joinMemoryJob(capMB: number): void {
  ffi();
  const job = k32.CreateJobObjectW(null, null);
  if (!job) throw new Error("CreateJobObjectW failed");
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64, 144 bytes): LimitFlags @16, JobMemoryLimit @120.
  const info = new Uint8Array(144), dv = new DataView(info.buffer);
  dv.setUint32(16, 0x200 | 0x2000, true); // JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  dv.setBigUint64(120, BigInt(capMB) * 1048576n, true);
  if (!k32.SetInformationJobObject(job, 9, ffiPtr(info), 144)) throw new Error("SetInformationJobObject failed");
  if (!k32.AssignProcessToJobObject(job, k32.GetCurrentProcess())) throw new Error("AssignProcessToJobObject failed");
  // The handle stays open until we exit; closing it (our death) kills the whole run.
}

export const windows: Platform = {
  id: "windows",
  claudeBinary: "claude.exe",
  exeSuffix: ".exe",

  freeRamMB: () => memStatus()?.availPhys ?? 0,
  swapUsedMB: () => Number(ps("(Get-CimInstance Win32_PageFileUsage | Measure-Object CurrentUsage -Sum).Sum").out.trim()) || 0,
  commitMB: () => {
    const m = memStatus();
    return m ? { used: m.commitLimit - m.commitAvail, limit: m.commitLimit } : null;
  },

  processes(): Proc[] {
    const r = ps(
      "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; c = $_.ParentProcessId; n = $_.Name; l = $_.CommandLine; " +
        "t = $(if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } else { 0 }) } } | ConvertTo-Json -Compress",
    );
    const list: any[] = JSON.parse(r.out || "[]");
    ffi();
    return list.map((x) => ({ pid: x.p, ppid: x.c, name: x.n ?? "", cmdline: x.l ?? "", cwd: cwdOf(x.p), started: Number(x.t) || 0 }));
  },

  topProcesses: (n) =>
    ps(`Get-Process | Sort-Object WS -Descending | Select-Object -First ${n} | ForEach-Object { '{0} {1}MB {2}' -f $_.Id, [int]($_.WS/1MB), $_.ProcessName }`).out.trim(),

  memoryCapKind: () => "job object (JOB_OBJECT_LIMIT_JOB_MEMORY)",

  async runCapped(cmd, capMB) {
    joinMemoryJob(capMB);
    setPriority(10); // BELOW_NORMAL, inherited by children
    return runInherit(cmd);
  },

  rendererLoad() {
    const r = ps(
      `$ds = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match '--type=renderer' } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
$a = @{}; foreach ($p in $ds) { foreach ($t in $p.Threads) { $a["$($p.Id):$($t.Id)"] = $t.TotalProcessorTime.TotalMilliseconds } }
Start-Sleep -Seconds 2
foreach ($p in $ds) { $q = Get-Process -Id $p.Id -ErrorAction SilentlyContinue; if (-not $q) { continue }; $m = 0; foreach ($t in $q.Threads) { $k = "$($q.Id):$($t.Id)"; if ($a.ContainsKey($k)) { $v = ($t.TotalProcessorTime.TotalMilliseconds - $a[$k]) / 20; if ($v -gt $m) { $m = $v } } }; "$($q.Id)=$([int]$m)" }`,
    );
    return r.out.split(/\r?\n/).map((l) => /^(\d+)=(\d+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => ({ pid: Number(m[1]), pct: Number(m[2]) }));
  },

  vscodeExtensionRoots: () => [".vscode/extensions", ".vscode-insiders/extensions"].map((d) => join(HOME, d)),

  addToUserPath(dir) {
    const win = dir.replace(/\//g, "\\");
    const r = ps(
      `$p = [Environment]::GetEnvironmentVariable('Path','User'); if (-not $p) { $p = '' }; ` +
        `if (($p -split ';') -notcontains '${win}') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${win}').TrimStart(';'), 'User'); 'added' } else { 'present' }`,
    );
    return r.out.trim() === "added" ? `added ${win} to the user PATH (new terminals see it)` : `${win} already on the user PATH`;
  },
};
