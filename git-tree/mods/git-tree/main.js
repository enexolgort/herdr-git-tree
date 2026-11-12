import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, props } from "herdr";

// Where the focused terminal is: its live folder and machine (as the Changes panel finds it).
// When a mod pane (this one, when clicked) has focus, follow a terminal in the same tab instead.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal && p.cwd) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Read-only git: never touch the index or locks, so watching .git never loops on our own reads.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "color.ui=never"];
const LIMIT = 400;
const ROW = 22;
const GRAPH_ROW = 12; // rows that are only branch lines
const SEP = "\x1f";

function parseLog(stdout) {
  const rows = [];
  for (const line of stdout.replace(/\r/g, "").replace(/\n$/, "").split("\n")) {
    const at = line.indexOf(SEP);
    if (at < 0) { rows.push({ graph: line.replace(/\s+$/, "") }); continue; }
    const [hash, full, refs, subject, author, when] = line.slice(at + 1).split(SEP);
    rows.push({ graph: line.slice(0, at).replace(/\s+$/, ""), hash, full, subject, author, when,
      refs: refs ? refs.split(", ").filter(Boolean) : [] });
  }
  return rows;
}

// Graph cells are drawn, not typed: git's "|" only appears between side-by-side branches,
// so text leaves the dots of a straight history unconnected. Each lane gets a full-height
// line, a commit's dot sits on it, and "/" "\\" are diagonals reaching the next lane's centre.
const CW = 8;
const at = (row, i) => (row?.graph ?? "")[i] ?? " ";
function linkedAbove(prev, i) {
  return "|*".includes(at(prev, i)) || at(prev, i - 1) === "\\" || at(prev, i + 1) === "/";
}
function linkedBelow(next, i) {
  return "|*".includes(at(next, i)) || at(next, i - 1) === "/" || at(next, i + 1) === "\\";
}

export default class GitTree extends View {
  init(_props, cx) {
    this.rows = []; this.root = null; this.branch = ""; this.error = null; this.selected = null; this.detail = [];
    try { this.all = localStorage.getItem("all") !== "0"; } catch { this.all = true; }
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  watch(dir, cx) {
    if (this.on || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) this.refresh(cx);
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  // Each refresh gets a number; only the newest one may write results, so a request that
  // hangs or is dropped never blocks the next one (no "loading" lock to get stuck on).
  refresh(cx) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.rows = []; this.root = null; this.branch = ""; this.error = null;
      this.selected = null; this.detail = []; this.watched = null;
    }
    if (!cwd) { this.error = "No folder"; this.loading = false; return; }
    const gen = this.gen = (this.gen ?? 0) + 1;
    const live = () => this.gen === gen && key() === context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const opts = { cwd, on, timeout: 20000 };
        const top = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], opts);
        if (!live()) return;
        if (top.code !== 0) { this.root = null; this.rows = []; this.error = "Not a git repository"; return; }
        const [root, gitDir] = top.stdout.trim().split(/\r?\n/);
        const git = (args) => exec("git", [...READ, ...args], { ...opts, cwd: root });
        const branch = await git(["branch", "--show-current"]);
        const log = await git(["log", "--graph", "--date-order", `-n${LIMIT}`, ...(this.all ? ["--all"] : []),
          `--format=${SEP}%h${SEP}%H${SEP}%D${SEP}%s${SEP}%an${SEP}%cr`]);
        if (!live()) return;
        this.root = root; this.on = on;
        this.branch = branch.stdout.trim() || "(detached)";
        if (log.code !== 0) {
          this.rows = [];
          this.error = /does not have any commits/.test(log.stderr) ? "No commits yet" : log.stderr.trim();
        } else { this.rows = parseLog(log.stdout); this.error = null; }
        this.watch(gitDir, cx);
      } catch (e) { if (live()) this.error = String(e); }
      finally {
        if (this.gen === gen) this.loading = false;
        cx.notify();
      }
    });
  }

  pick(row, cx) {
    if (this.selected === row.full) { this.selected = null; this.detail = []; cx.notify(); return; }
    this.selected = row.full; this.detail = ["Loading…"];
    const root = this.root, on = this.on, hash = row.full;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "show", "--stat", "--no-color", "--format=%H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B", hash], { cwd: root, on });
        if (this.selected === hash) this.detail = (r.code === 0 ? r.stdout : r.stderr).replace(/\s+$/, "").split(/\r?\n/).slice(0, 300);
      } catch (e) { if (this.selected === hash) this.detail = [String(e)]; }
      cx.notify();
    });
    cx.notify();
  }

  toggleAll(cx) {
    this.all = !this.all;
    try { localStorage.setItem("all", this.all ? "1" : "0"); } catch {}
    this.refresh(cx); cx.notify();
  }

  ref(name, t) {
    let label = name, color = t.ansi4;
    if (name.startsWith("HEAD -> ")) { label = name.slice(8); color = t.accent; }
    else if (name === "HEAD") color = t.accent;
    else if (name.startsWith("tag: ")) { label = name.slice(5); color = t.ansi3; }
    else if (name.includes("/")) color = t.ansi1;
    return div().flex_none().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(color + "88")
      .bg(color + "22").text_color(color).text_size(10).max_w(140).truncate().child(label);
  }

  graph(i, height, t, palette) {
    const row = this.rows[i], prev = this.rows[i - 1], next = this.rows[i + 1], g = row.graph;
    const cells = [];
    for (let c = 0; c < g.length; c++) {
      const ch = g[c], color = palette[Math.floor(c / 2) % palette.length] ?? t.dim, x = c * CW;
      const vline = (top, h) => div().absolute().left(x + CW / 2 - 1).top(top).w(2).h(h).bg(color);
      if (ch === "|") cells.push(vline(0, height));
      else if (ch === "*") {
        if (linkedAbove(prev, c)) cells.push(vline(0, height / 2));
        if (linkedBelow(next, c)) cells.push(vline(height / 2, height / 2));
        cells.push(div().absolute().left(x + CW / 2 - 4).top(height / 2 - 4).size(8).rounded(4).bg(color)
          .border_1().border_color(t.background));
      } else if (ch === "/" || ch === "\\") {
        cells.push(svg(`mods/git-tree/${ch === "/" ? "slash" : "backslash"}.svg`).absolute()
          .left(x - CW).top(0).w(CW * 3).h(height).text_color(color));
      } else if (ch === "_") cells.push(div().absolute().left(x - CW / 2).top(height - 2).w(CW * 2).h(2).bg(color));
      else if (ch === "-" || ch === ".") cells.push(div().absolute().left(x).top(height / 2 - 1).w(CW).h(2).bg(color));
    }
    return div().flex_none().relative().w(Math.max(1, g.length) * CW).h(height).children(cells);
  }

  row(row, i, t, palette) {
    const graph = this.graph(i, row.hash ? ROW : GRAPH_ROW, t, palette);
    if (!row.hash) return h_flex().id(`g-${i}`).w_full().h(GRAPH_ROW).flex_none().px(10).child(graph);
    const selected = this.selected === row.full;
    return h_flex().id(`c-${i}`).w_full().h(ROW).flex_none().px(10).gap(8).items_center().cursor_pointer()
      .when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(row, cx))
      .child(graph)
      .child(div().flex_none().text_color(t.dim).child(row.hash))
      .children(row.refs.map((r) => this.ref(r, t)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(row.subject || " "))
      .child(div().flex_none().text_color(t.dim).text_size(10).child(`${row.author} · ${row.when}`));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono";
    const palette = [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi13, t.ansi10, t.ansi11];
    const repo = this.root ? this.root.split(/[\\/]/).filter(Boolean).pop() : null;
    const commits = this.rows.filter((r) => r.hash).length;
    // As a side panel it draws its own card (like Changes); as a pane, the pane frame does.
    return v_flex().id("git-tree").size_full().min_h(0).overflow_hidden().bg(t.background)
      .when(Boolean(props()?.panel), (e) => e.rounded(10).border_1().border_color(t.border))
      .text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().text_size(13).child("Git tree"))
        .when(Boolean(repo), (e) => e.child(div().min_w(0).truncate().text_color(t.muted).child(`${repo} · ${this.branch}`)))
        .child(div().flex_1())
        .when(commits > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`${commits}${commits >= LIMIT ? "+" : ""} commits`)))
        .child(div().id("git-tree-all").flex_none().px(8).h(22).flex().items_center().rounded(6).cursor_pointer()
          .border_1().border_color(this.all ? t.accent : t.border).text_size(11)
          .text_color(this.all ? t.accent : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleAll(cx)).child(this.all ? "All branches" : "This branch")))
      .child(div().flex_1().min_h(0).relative().font_family(mono).text_size(12)
        .when(this.rows.length > 0, (e) => e
          .child(v_flex().id("git-tree-list").absolute().inset_0().overflow_y_scroll().py(4)
            .children(this.rows.map((r, i) => this.row(r, i, t, palette))))
          .child(Scrollbar.vertical("git-tree-list").absolute().inset_0()))
        .when(!this.rows.length, (e) => e.child(div().p(14).text_color(t.dim)
          .child(this.error || (this.loading ? "Loading…" : "No commits")))))
      .when(this.selected !== null, (e) => e.child(div().h(220).flex_none().relative().border_t(1).border_color(t.border)
        .font_family(mono).text_size(11)
        .child(v_flex().id("git-tree-detail").absolute().inset_0().overflow_y_scroll().p(10)
          .children(this.detail.map((l, i) => div().id(`d-${i}`).flex_none().whitespace_nowrap()
            .text_color(i === 0 ? t.ansi3 : /\|\s+\d+/.test(l) ? t.muted : t.foreground).child(l || " "))))
        .child(Scrollbar.vertical("git-tree-detail").absolute().inset_0())));
  }
}
