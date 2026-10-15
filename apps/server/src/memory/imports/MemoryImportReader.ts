// @effect-diagnostics-next-line nodeBuiltinImport:off -- narrow non-inheriting descriptor/Git process boundary.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- snapshot digest, no provider identity derivation.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- acquisition validates absolute server configuration only.
import * as NodePath from "node:path";
import {
  MemoryImportRpcError,
  type MemoryImportFormat,
  type MemoryImportIssue,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type {
  ImportDiscoveredSlot,
  ImportSlot,
  ImportSnapshot,
  MemoryImportReaderShape,
} from "./MemoryImportTypes.ts";

const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";
const PROCESS_LIMIT = 8 * 1024 * 1024;
const PROCESS_TIMEOUT = 10_000;
const PROFILES = [
  "codex-handbook-v1",
  "codex-ad-hoc-v1",
  "claude-topic-v1",
  "claude-topic-metadata-v1",
  "omo-memory-core-beta63",
] as const;

/** Server acquisition configuration only; no caller paths or provider settings lookup. */
export type MemoryImportReaderConfig = {
  readonly stateDir: string;
  readonly roots: readonly {
    readonly format: MemoryImportFormat;
    readonly rootSlot: string;
    readonly path: string;
  }[];
  readonly gitExecutable: string;
  /** Python 3 supplies openat/dir_fd absent from Node FS; unavailable platforms refuse. */
  readonly descriptorExecutable: string;
  /** Value-free lifecycle observation; no source bytes, paths, arguments or environment. */
  readonly onProcessSpawn?: (event: { readonly operation: string; readonly pid: number }) => void;
};

// The broker has no provider write operation. All source opens are parent-descriptor relative.
// Python is invoked isolated (-I -S), with a complete static env and no shell. It never imports
// source modules/configuration. Only private snapshot paths can be opened for writes/removal.
const DESCRIPTORS = String.raw`
import os, sys, stat, json, errno, re
class Refusal(Exception):
    def __init__(self, issue): self.issue = issue

def refuse(issue): raise Refusal(issue)
def valid(s):
    if not s or len(s.encode('utf-8', 'strict')) > 512 or '\\' in s or '\x00' in s or any(p in ('', '.', '..') for p in s.split('/')): refuse('path_rejected')
def identity(s): return (s.st_dev, s.st_ino, s.st_mode)
def stamp(s): return identity(s) + (s.st_size, s.st_mtime_ns, s.st_ctime_ns)
held=[]; checks=[]
def open_child(parent, name, directory=False, stable=True, expected=None):
    valid(name)
    try: before=os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        if expected is not None: refuse('source_changed')
        raise
    if expected is not None and stamp(before)!=stamp(expected): refuse('source_changed')
    if stat.S_ISLNK(before.st_mode) or not (stat.S_ISDIR(before.st_mode) if directory else stat.S_ISREG(before.st_mode)): refuse('path_rejected')
    fd=os.open(name, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else os.O_NONBLOCK), dir_fd=parent)
    after=os.fstat(fd)
    if stamp(before)!=stamp(after): os.close(fd); refuse('source_changed')
    held.append(fd); checks.append((parent, name, fd, after, stable))
    return fd

def absolute(path, create=False):
    if not path.startswith('/') or path=='/' or path.endswith('/'): refuse('path_rejected')
    valid(path[1:]); fd=os.open('/', os.O_RDONLY | os.O_DIRECTORY); held.append(fd)
    for part in path[1:].split('/'):
        if create:
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
        fd=open_child(fd, part, True, False)
    return fd

def verify():
    for parent,name,fd,before,stable in checks:
        try: now=os.stat(name,dir_fd=parent,follow_symlinks=False)
        except FileNotFoundError: refuse('source_changed')
        cmp=stamp if stable else identity
        if cmp(now)!=cmp(before) or cmp(os.fstat(fd))!=cmp(before): refuse('source_changed')

def names(fd,maximum=4096):
    result=[]
    with os.scandir(fd) as entries:
        for entry in entries:
            name=entry.name
            try: valid(name)
            except UnicodeError: refuse('invalid_utf8')
            result.append(name)
            if len(result)>maximum: refuse('limit_exceeded')
    return sorted(result)

def read(fd, maximum):
    before=os.fstat(fd)
    if before.st_size>maximum: refuse('limit_exceeded')
    data=bytearray()
    while True:
        chunk=os.read(fd,min(65536,maximum-len(data)+1))
        if not chunk: break
        data.extend(chunk)
        if len(data)>maximum:
            if stamp(before)!=stamp(os.fstat(fd)): refuse('source_changed')
            refuse('limit_exceeded')
    if stamp(before)!=stamp(os.fstat(fd)) or len(data)!=before.st_size: refuse('source_changed')
    return bytes(data)

def text(data):
    try: s=data.decode('utf-8','strict')
    except UnicodeError: refuse('invalid_utf8')
    if '\x00' in s: refuse('path_rejected')
    return s

def own(fd):
    s=os.fstat(fd)
    if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700: refuse('path_rejected')

def destination(parent,name,directory=False):
    valid(name)
    if directory:
        os.mkdir(name,0o700,dir_fd=parent)
        fd=open_child(parent,name,True,False); own(fd); return fd
    fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
    return fd

def write(parent,name,data):
    fd=destination(parent,name)
    try:
        view=memoryview(data)
        while view:
            count=os.write(fd,view); view=view[count:]
    finally: os.close(fd)

c=json.loads(sys.argv[1]); action=c['action']; result={}
try:
    if not all(f in os.supports_dir_fd for f in (os.open,os.stat,os.mkdir,os.unlink,os.rmdir)) or os.scandir not in os.supports_fd or not hasattr(os,'O_NOFOLLOW'): refuse('path_rejected')
    if action in ('init','allocate','remove','cleanup'):
        state=absolute(c['stateDir'])
        state_stat=os.fstat(state)
        if state_stat.st_uid!=os.getuid() or stat.S_IMODE(state_stat.st_mode)&0o022: refuse('path_rejected')
        if action=='init':
            for part in ('memory-import','snapshots'):
                try: os.mkdir(part,0o700,dir_fd=state)
                except FileExistsError: pass
                state=open_child(state,part,True,False); own(state)
        else:
            state=open_child(state,'memory-import',True,False); own(state)
            state=open_child(state,'snapshots',True,False); own(state)
        if action=='allocate':
            dest=destination(state,c['id'],True)
            destination(dest,'repo',True); destination(dest,'cwd',True)
        if action in ('cleanup','remove'):
            entries=names(state,2)
            if len(entries)>2: refuse('limit_exceeded')
            if action=='remove': entries=[c['id']] if c['id'] in entries else []
            count=0; total=0; object_total=0; object_count=0
            def inspect(parent,name,depth,rel):
                global count,total,object_total,object_count
                count+=1
                if rel: valid(rel[5:] if rel.startswith('repo/') else rel)
                obj=rel=='repo/objects' or rel.startswith('repo/objects/')
                if obj: object_count+=1
                if count>4096 or object_count>3584 or depth>9: refuse('limit_exceeded')
                s=os.stat(name,dir_fd=parent,follow_symlinks=False)
                if s.st_uid!=os.getuid() or stat.S_ISLNK(s.st_mode): refuse('path_rejected')
                if stat.S_ISDIR(s.st_mode):
                    fd=open_child(parent,name,True,False); own(fd)
                    return (name,fd,[inspect(fd,n,depth+1,rel+'/'+n if rel else n) for n in names(fd)])
                if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode)!=0o600: refuse('path_rejected')
                total+=s.st_size
                if obj: object_total+=s.st_size
                if total>67108864 or object_total>62914560 : refuse('limit_exceeded')
                return (name,None,[])
            trees=[]
            for name in entries:
                if not name.startswith('snapshot-') or len(name)!=45: refuse('path_rejected')
                count=0; total=0; object_total=0; object_count=0
                trees.append(inspect(state,name,0,''))
            verify()
            def remove(parent,tree):
                name,fd,children=tree
                if fd is None: os.unlink(name,dir_fd=parent)
                else:
                    for child in children: remove(fd,child)
                    os.rmdir(name,dir_fd=parent)
            for tree in trees:
                if action=='cleanup' or tree[0]==c['id']: remove(state,tree)
    elif action=='discover':
        root=absolute(c['root']); entries=names(root,512)
        if len(entries)>512: refuse('limit_exceeded')
        result={'selections':[]}
        for name in entries:
            s=os.stat(name,dir_fd=root,follow_symlinks=False)
            if stat.S_ISLNK(s.st_mode): refuse('path_rejected')
            if stat.S_ISDIR(s.st_mode):
                result['selections'].append(name)
                if len(result['selections'])>128: refuse('limit_exceeded')
        verify()
    elif action=='copy':
        root=absolute(c['root']); source=root
        for part in c['relative'].split('/'):
            source=open_child(source,part,True)
        dest=absolute(c['snapshot']); own(dest)
        count=4 if c['format']=='omo' else 0; objects_count=0; total=len(c['config'].encode()); object_bytes=0; source_bytes=0; files=[]
        def walk(parent,out,rel,depth,git=False):
            global count,objects_count,total,object_bytes,source_bytes
            for name in names(parent,(4096 if git else 512)-count):
                selector=rel+'/'+name if rel else name
                valid(selector); count+=1
                obj=selector=='objects' or selector.startswith('objects/')
                if obj: objects_count+=1
                if count>(4096 if git else 512) or objects_count>3584 or depth>8: refuse('limit_exceeded')
                try: s=os.stat(name,dir_fd=parent,follow_symlinks=False)
                except FileNotFoundError: refuse('source_changed')
                if stat.S_ISLNK(s.st_mode) or not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)): refuse('path_rejected')
                if git and selector in ('commondir','objects/info/alternates','objects/info/http-alternates'): refuse('path_rejected')
                selected = (selector in ('HEAD','packed-refs') or selector.startswith('refs/') and not selector.startswith('refs/replace') or obj and not selector.startswith('objects/info')) if git else (selector=='MEMORY.md' or selector.startswith('extensions/ad_hoc/notes/') and selector.count('/')==3 and selector.endswith('.md')) if c['format']=='codex' else ('/' not in selector and selector.endswith('.md') and selector not in ('MEMORY.md','CLAUDE.md'))
                if stat.S_ISDIR(s.st_mode):
                    fd=open_child(parent,name,True,True,s)
                    child=destination(out,name,True) if git and (selector in ('refs','objects') or selector.startswith('refs/') and not selector.startswith('refs/replace') or obj and not selector.startswith('objects/info')) else out
                    walk(fd,child,selector,depth+1,git)
                elif git and selector=='config':
                    fd=open_child(parent,name,False,True,s)
                    config_text=text(read(fd,262144)).lower()
                    if re.search(r'^\s*\[\s*include(?:if)?\b',config_text,re.M): refuse('path_rejected')
                    if re.search(r'^\s*\[\s*extensions\b',config_text,re.M): refuse('unsupported_format')
                elif selected:
                    if git:
                        total+=s.st_size
                        if obj: object_bytes+=s.st_size
                        if total>67108864 or object_bytes>62914560 or total-object_bytes>4194304: refuse('limit_exceeded')
                    else:
                        source_bytes+=s.st_size
                        if source_bytes>8388608: refuse('limit_exceeded')
                    fd=open_child(parent,name,False,True,s)
                    data=read(fd,s.st_size if git else 262144)
                    # File descriptors need not stay open; parent-relative restat remains in checks.
                    checks[-1]=(parent,name,None,s,True); held.remove(fd); os.close(fd)
                    if git: write(out,name,data)
                    else:
                        content=text(data); files.append({'selector':selector,'text':content,'byteCount':len(data)})
                        write(out,str(len(files))+'.txt',data)
        if c['format']=='omo':
            metadata=open_child(source,'.git',True)
            walk(metadata,dest,'',1,True)
            write(dest,'config',c['config'].encode())
        else: walk(source,dest,'',1)
        # Revalidate all opened source entries/ancestor chains at the seal point.
        for parent,name,fd,before,stable in checks:
            try: now=os.stat(name,dir_fd=parent,follow_symlinks=False)
            except FileNotFoundError: refuse('source_changed')
            cmp=stamp if stable else identity
            if cmp(now)!=cmp(before) or fd is not None and cmp(os.fstat(fd))!=cmp(before): refuse('source_changed')
        result={'files':files}
    else: refuse('source_unreadable')
    print(json.dumps(result,separators=(',',':')))
except Refusal as e:
    print(json.dumps({'issue':e.issue})); sys.exit(2)
except FileNotFoundError:
    print('{"issue":"source_missing"}'); sys.exit(2)
except OSError as e:
    print(json.dumps({'issue':'path_rejected' if e.errno in (errno.ELOOP,errno.ENOTDIR) else 'source_unreadable'})); sys.exit(2)
except (ValueError,UnicodeError,KeyError):
    print('{"issue":"path_rejected"}'); sys.exit(2)
finally:
    for fd in reversed(held): os.close(fd)
`;

type Budget = {
  live: number;
  unavailable: boolean;
  owners: number;
  initializing: boolean;
  slots: Semaphore.Semaphore;
};
// Deliberate server/stateDir admission ownership, shared by acquisitions in this process.
const budgets = new Map<string, Budget>();
const error = (issue: MemoryImportIssue) => new MemoryImportRpcError({ issue });
const isImportError = Schema.is(MemoryImportRpcError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const normalize = (cause: unknown) => (isImportError(cause) ? cause : error("source_unreadable"));
const safe = (value: string) => {
  if (
    !value ||
    Buffer.byteLength(value) > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw error("path_rejected");
  if (scanMemoryValue(value).kind === "blocked") throw error("secret_detected");
};
const absolute = (path: string) => {
  if (!NodePath.isAbsolute(path) || path === "/" || NodePath.normalize(path) !== path)
    throw error("path_rejected");
  safe(path.slice(1));
};

const validateStateBoundary = (config: MemoryImportReaderConfig) => {
  for (const root of config.roots) {
    absolute(root.path);
    if (
      config.stateDir === root.path ||
      config.stateDir.startsWith(`${root.path}/`) ||
      root.path.startsWith(`${config.stateDir}/`)
    )
      throw error("path_rejected");
    for (const executable of [config.gitExecutable, config.descriptorExecutable]) {
      if (executable === root.path || executable.startsWith(`${root.path}/`))
        throw error("path_rejected");
    }
  }
};

/** A complete map: Node spawn's env replaces inheritance; host env is never enumerated. */
const environment = (cwd: string, gitDir?: string) => ({
  PATH: "/usr/bin:/bin",
  HOME: cwd,
  XDG_CONFIG_HOME: cwd,
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "",
  ...(gitDir ? { GIT_DIR: gitDir } : {}),
});

// Owned process finishes (including timeout/interruption) before snapshot cleanup can run.
const execute = (
  executable: string,
  args: readonly string[],
  cwd: string,
  maxBytes: number,
  gitDir?: string,
  onSpawn?: (pid: number) => void,
) =>
  Effect.callback<{ code: number; bytes: Buffer }, MemoryImportRpcError>((resume) => {
    let child: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      child = NodeChildProcess.spawn(executable, [...args], {
        cwd,
        env: environment(cwd, gitDir),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resume(Effect.fail(error("source_unreadable")));
      return;
    }
    child.stdin.end();
    let size = 0;
    let failed = false;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    // @effect-diagnostics-next-line globalTimersInEffect:off -- owned OS-process watchdog; interruption waits for close, never polls.
    const timer = setTimeout(stop, PROCESS_TIMEOUT);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop();
      else chunks.push(chunk);
    });
    // Never retain or expose stderr. It has the same bound, independent of stdout.
    let stderr = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr > maxBytes) stop();
    });
    child.on("error", () => {
      failed = true;
    });
    let ended = false;
    const waiters: (() => void)[] = [];
    child.on("close", (code) => {
      ended = true;
      clearTimeout(timer);
      for (const waiter of waiters) waiter();
      resume(
        failed
          ? Effect.fail(error("source_unreadable"))
          : Effect.succeed({ code: code ?? -1, bytes: Buffer.concat(chunks) }),
      );
    });
    try {
      if (child.pid !== undefined) onSpawn?.(child.pid);
    } catch {
      stop();
    }
    return Effect.callback<void>((done) => {
      if (ended) done(Effect.void);
      else {
        waiters.push(() => done(Effect.void));
        stop();
      }
    });
  });

const decodeBroker = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      issue: Schema.optionalKey(
        Schema.Literals([
          "source_missing",
          "source_unreadable",
          "source_changed",
          "path_rejected",
          "limit_exceeded",
          "invalid_utf8",
          "unsupported_format",
        ]),
      ),
      files: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            selector: Schema.String,
            text: Schema.String,
            byteCount: Schema.Number,
          }),
        ),
      ),
      selections: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
);

const broker = (config: MemoryImportReaderConfig, input: Record<string, unknown>) =>
  execute(
    config.descriptorExecutable,
    ["-I", "-S", "-c", DESCRIPTORS, encodeJson(input)],
    config.stateDir,
    12 * 1024 * 1024,
    undefined,
    (pid) => config.onProcessSpawn?.({ operation: String(input.action), pid }),
  ).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => {
          const value = decodeBroker(result.bytes.toString("utf8"));
          if (value.issue) throw error(value.issue);
          if (result.code !== 0) throw error("source_unreadable");
          return value;
        },
        catch: normalize,
      }),
    ),
  );

/** L5 must await this before activation. Single server owner per stateDir is a deployment precondition. */
export const cleanupMemoryImportSnapshots = (config: MemoryImportReaderConfig) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        absolute(config.stateDir);
        validateStateBoundary(config);
        absolute(config.descriptorExecutable);
      },
      catch: normalize,
    });
    const budget = budgets.get(config.stateDir);
    if (budget && (budget.owners > 0 || budget.live > 0 || budget.initializing))
      return yield* Effect.fail(error("source_unreadable"));
    yield* broker(config, { action: "init", stateDir: config.stateDir });
    yield* broker(config, { action: "cleanup", stateDir: config.stateDir });
    budgets.delete(config.stateDir);
  });

/** Acquire once in L5's Scope; discover/read themselves have no Scope requirement. */
export const acquireMemoryImportReader = (config: MemoryImportReaderConfig) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        absolute(config.stateDir);
        validateStateBoundary(config);
        absolute(config.gitExecutable);
        absolute(config.descriptorExecutable);
        if (config.roots.length > 128) throw error("limit_exceeded");
        const keys = new Set<string>();
        for (const root of config.roots) {
          absolute(root.path);
          safe(root.rootSlot);
          if (root.rootSlot.includes("/") || [...root.rootSlot].length > 256)
            throw error("path_rejected");
          const key = `${root.format}/${root.rootSlot}`;
          if (keys.has(key)) throw error("path_rejected");
          keys.add(key);
        }
      },
      catch: normalize,
    });
    const roots = config.roots.map((root) => ({ ...root }));
    const previous = budgets.get(config.stateDir);
    const slots = yield* Semaphore.make(2);
    const budget: Budget = previous ?? {
      live: 0,
      unavailable: false,
      owners: 0,
      initializing: true,
      slots,
    };
    if (previous?.initializing || previous?.unavailable)
      return yield* Effect.fail(error("source_unreadable"));
    budgets.set(config.stateDir, budget);
    if (!previous) {
      yield* broker(config, { action: "init", stateDir: config.stateDir }).pipe(
        Effect.andThen(broker(config, { action: "cleanup", stateDir: config.stateDir })),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            budget.initializing = false;
            if (exit._tag === "Failure") budget.unavailable = true;
          }),
        ),
      );
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        budget.owners++;
      }),
      () =>
        Effect.sync(() => {
          budget.owners--;
        }),
    );
    let closed = false;
    const operations = yield* Scope.make();
    yield* Effect.addFinalizer((exit) =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(Scope.close(operations, exit))),
    );
    const manage = <A>(operation: Effect.Effect<A, MemoryImportRpcError>) =>
      Effect.try({
        try: () => {
          if (closed || budget.unavailable) throw error("source_unreadable");
        },
        catch: normalize,
      }).pipe(
        Effect.andThen(
          Effect.acquireUseRelease(
            Effect.forkIn(operation, operations),
            Fiber.join,
            Fiber.interrupt,
          ),
        ),
      );
    const available = () => {
      if (closed || budget.unavailable) throw error("source_unreadable");
    };
    const snapshot = <A>(use: (path: string) => Effect.Effect<A, MemoryImportRpcError>) =>
      Effect.gen(function* () {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const id = yield* Effect.acquireRelease(
              Effect.gen(function* () {
                const id = yield* Effect.try({
                  try: () => {
                    available();
                    return `snapshot-${NodeCrypto.randomUUID()}`;
                  },
                  catch: normalize,
                });
                if (!(yield* budget.slots.takeIfAvailable(1)))
                  return yield* Effect.fail(error("limit_exceeded"));
                budget.live++;
                return id;
              }),
              (id) =>
                broker(config, { action: "remove", stateDir: config.stateDir, id }).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      budget.live--;
                    }).pipe(Effect.andThen(budget.slots.release(1))),
                  ),
                  Effect.catch(() =>
                    Effect.sync(() => {
                      budget.unavailable = true;
                    }),
                  ),
                ),
            );
            yield* broker(config, { action: "allocate", stateDir: config.stateDir, id });
            return yield* use(NodePath.join(config.stateDir, "memory-import", "snapshots", id));
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.fail(budget.unavailable ? error("source_unreadable") : cause),
          ),
          Effect.flatMap((value) =>
            budget.unavailable ? Effect.fail(error("source_unreadable")) : Effect.succeed(value),
          ),
        );
      });
    const locate = (slot: ImportSlot) => {
      available();
      safe(slot.rootSlot);
      const root = roots.find((r) => r.format === slot.format && r.rootSlot === slot.rootSlot);
      if (!root) throw error("source_missing");
      if (slot.format === "codex") {
        if (slot.selection !== null) throw error("path_rejected");
      } else {
        if (slot.selection === null) throw error("path_rejected");
        safe(slot.selection);
        if (slot.selection.includes("/")) throw error("path_rejected");
      }
      return root;
    };
    const metadata = (slot: ImportSlot, profile: string): ImportDiscoveredSlot => {
      const sourceLocator = `${slot.format}/${slot.rootSlot}${slot.selection ? `/${slot.selection}` : ""}`;
      safe(sourceLocator);
      return { slot, profile, parserVersion: profile, sourceLocator, label: slot.rootSlot };
    };
    const read: MemoryImportReaderShape["read"] = ({ slot }) =>
      Effect.gen(function* () {
        const root = yield* Effect.try({ try: () => locate(slot), catch: normalize });
        return yield* snapshot((path) =>
          Effect.gen(function* () {
            const repo = NodePath.join(path, "repo");
            const copied = yield* broker(config, {
              action: "copy",
              root: root.path,
              relative:
                slot.format === "codex"
                  ? "memories"
                  : `${slot.selection}/${slot.format === "claude" ? "memory" : "repo"}`,
              snapshot: repo,
              format: slot.format,
              config: slot.format === "omo" ? CONFIG : "",
            });
            let files = [...(copied.files ?? [])];
            let commitOid: string | undefined;
            let profile: string;
            if (slot.format === "omo") {
              const git = (args: readonly string[], cap = PROCESS_LIMIT) =>
                execute(
                  config.gitExecutable,
                  [
                    "--no-replace-objects",
                    "-c",
                    "credential.helper=",
                    "-c",
                    "core.askPass=",
                    "-c",
                    "protocol.allow=never",
                    ...args,
                  ],
                  NodePath.join(path, "cwd"),
                  cap,
                  repo,
                  (pid) => config.onProcessSpawn?.({ operation: "git", pid }),
                ).pipe(
                  Effect.flatMap((result) =>
                    result.code === 0
                      ? Effect.succeed(result.bytes)
                      : Effect.fail(error("source_unreadable")),
                  ),
                );
              const version = (yield* git(["--version"], 256)).toString("utf8");
              // Support policy: Git 2.48–2.99 only, with --no-lazy-fetch on every repository call. Unknown versions refuse.
              if (!/^git version 2\.(?:4[8-9]|[5-9][0-9])\.[0-9]+(?:\s|$)/.test(version))
                return yield* Effect.fail(error("source_unreadable"));
              const run = (args: readonly string[], cap?: number) =>
                git(["--no-lazy-fetch", ...args], cap);
              commitOid = (yield* run(["rev-parse", "--verify", "HEAD^{commit}"], 128))
                .toString("utf8")
                .trim();
              if (!/^[0-9a-f]{40}$/.test(commitOid))
                return yield* Effect.fail(error("unsupported_format"));
              const tree = yield* run(["ls-tree", "-rz", "--full-tree", commitOid]);
              files = [];
              let bytes = 0;
              const treeText = yield* Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true }).decode(tree),
                catch: () => error("invalid_utf8"),
              });
              const entries = treeText.split("\0").filter(Boolean);
              if (entries.length > 512) return yield* Effect.fail(error("limit_exceeded"));
              for (const entry of entries) {
                const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/s.exec(entry);
                if (!match) return yield* Effect.fail(error("unsupported_format"));
                const [, mode, type, oid, selector] = match;
                yield* Effect.try({
                  try: () => {
                    safe(selector!);
                    if (selector!.split("/").length > 8) throw error("limit_exceeded");
                    if ((mode !== "100644" && mode !== "100755") || type !== "blob")
                      throw error("path_rejected");
                  },
                  catch: normalize,
                });
                if (!/^(system|notes|people|reference|projects)\/.*\.md$/.test(selector!)) continue;
                const size = Number(
                  (yield* run(["cat-file", "-s", oid!], 32)).toString("ascii").trim(),
                );
                if (!Number.isSafeInteger(size) || size < 0)
                  return yield* Effect.fail(error("source_unreadable"));
                bytes += size;
                if (size > 262144 || bytes > PROCESS_LIMIT)
                  return yield* Effect.fail(error("limit_exceeded"));
                const content = yield* run(["cat-file", "blob", oid!], 262144);
                if (content.length !== size) return yield* Effect.fail(error("source_changed"));
                const text = yield* Effect.try({
                  try: () => new TextDecoder("utf-8", { fatal: true }).decode(content),
                  catch: () => error("invalid_utf8"),
                });
                files.push({ selector: selector!, text, byteCount: content.length });
              }
              profile = PROFILES[4];
            } else if (slot.format === "codex") {
              // One registered slot may contain both supported Codex profiles; L3 can dispatch per selector.
              profile = files.some((file) => file.selector === "MEMORY.md")
                ? PROFILES[0]
                : PROFILES[1];
            } else
              profile = files.some((file) => /^metadata:\s*$/m.test(file.text))
                ? PROFILES[3]
                : PROFILES[2];
            yield* Effect.try({
              try: () => {
                if (!files.length) throw error("source_missing");
                for (const file of files) {
                  safe(file.selector);
                  if (file.text.includes("\0")) throw error("path_rejected");
                  if (scanMemoryValue(file.text).kind === "blocked") throw error("secret_detected");
                }
              },
              catch: normalize,
            });
            files.sort((a, b) => a.selector.localeCompare(b.selector, "en"));
            const info = yield* Effect.try({
              try: () => metadata(slot, profile),
              catch: normalize,
            });
            return {
              ...info,
              format: slot.format,
              files,
              snapshotDigest: NodeCrypto.createHash("sha256")
                .update(encodeJson([profile, commitOid ?? null, files]))
                .digest("hex"),
              ...(commitOid ? { commitOid } : {}),
            } satisfies ImportSnapshot;
          }),
        );
      });
    const discover: MemoryImportReaderShape["discover"] = ({ format }) =>
      Effect.gen(function* () {
        yield* Effect.try({ try: available, catch: normalize });
        const result: ImportDiscoveredSlot[] = [];
        for (const root of roots.filter((root) => root.format === format)) {
          const selections =
            format === "codex"
              ? [null]
              : ((yield* broker(config, { action: "discover", root: root.path })).selections ?? []);
          for (const selection of selections) {
            if (result.length >= 128) return yield* Effect.fail(error("limit_exceeded"));
            const slot: ImportSlot = { format, rootSlot: root.rootSlot, selection };
            const value = yield* read({ slot });
            result.push(
              yield* Effect.try({ try: () => metadata(slot, value.profile), catch: normalize }),
            );
          }
        }
        return result;
      });
    return {
      discover: (input) => manage(discover(input)),
      read: (input) => manage(read({ slot: { ...input.slot } })),
    } satisfies MemoryImportReaderShape;
  });
