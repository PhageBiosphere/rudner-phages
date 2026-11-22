// Rudner Lab phage data entry. First version: restriction digests (plan, lab, compare).
(function () {
  "use strict";
  const CFG = window.RUDNER_CONFIG, DG = window.Digest, esc = DG.esc;
  // A test can supply its own client as window.__TEST_SUPABASE__; the site itself always uses the real one.
  const sb = window.__TEST_SUPABASE__ || window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
  const app = document.getElementById("app"), userBox = document.getElementById("user");
  const CALLS = [["Digestion", "Digestion", "ok"], ["Partial digestion", "Partial", "warn"], ["No digestion", "No digestion", "bad"], ["Uninterpretable", "Unclear", "mute"]];
  const fmt = (n) => Number(n).toLocaleString();
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const S = {
    user: null, role: null, name: "",
    catalog: [], enzymes: [], digestIndex: new Map(),   // phage_id -> [{experiment summary}]
    phage: null, digests: [], results: [],
    genome: null,          // {seq, label, source, circular, assembly_id, sha256} or {error}
    genes: null,           // {hits:[term], n}
    D: null, msg: "", busy: "", open: { enz: null, gel: null },
    sort: { k: "name", dir: 1 }, filters: { name: "", lab: "", host: "", cluster: "", genome: "", digest: "" }, pageSize: 25, page: 0,
    control: null          // {seq, name}
  };

  // ---------- small helpers ----------
  const publicUrl = (path) => (path ? sb.storage.from(CFG.IMAGE_BUCKET).getPublicUrl(path).data.publicUrl : "");
  const enzyme = (id) => S.enzymes.find((z) => z.restriction_enzyme_id === id) || {};
  const laneName = (L) => (L.sp === "ladder" ? "Ladder" : L.sp === "uncut" ? "Uncut" : enzyme(L.id).enzyme_name || "?");
  const cutsOf = (id) => (S.genome && S.genome.seq ? DG.digest(S.genome.seq, enzyme(id).recognition_sequence, S.genome.circular) : null);
  const virtualCall = (id) => { const c = cutsOf(id); if (c) return c.sites > 0 ? "Digestion" : "No digestion"; const o = S.D && S.D.saved.get(id); return (o && o.virtual_digest_result) || ""; };
  const isBlocked = (L) => !L.sp && virtualCall(L.id) === "Digestion" && L.observed === "No digestion";
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  function stageOf(x, results) {
    const lanes = Array.isArray(x.lane_layout) ? x.lane_layout.filter((t) => t !== "L" && t !== "U") : [];
    const done = (results || []).filter((r) => r.restriction_digest_experiment_id === x.restriction_digest_experiment_id);
    const compared = lanes.length > 0 && lanes.every((id) => done.some((r) => r.restriction_enzyme_id === id)) && x.positive_control_passed != null;
    return { planned: lanes.length > 0, lab: !!(x.gel_image_path || x.gel_image_url), compared };
  }
  // Images already recorded for the phage itself (for most phages these are the PhagesDB digest pictures).
  const srcName = (u) => (/phagesdb\.org/i.test(u || "") ? "PhagesDB" : "the phage record");
  const phageGel = () => (S.phage && S.phage.restriction_digest_image_url) || "";
  // The virtual digest is always drawn from the DNA sequence so every phage looks the same; PhagesDB virtual images are not used.
  const phageVirtual = () => "";
  const chip = (text, kind) => `<span class="chip ${kind || ""}">${esc(text)}</span>`;

  // ---------- data ----------
  async function loadSession() {
    const { data } = await sb.auth.getSession();
    S.user = data && data.session ? data.session.user : null;
    S.role = null; S.name = "";
    if (S.user) {
      const m = await sb.from("lab_members").select("role,display_name,active").eq("user_id", S.user.id).maybeSingle();
      if (m.data && m.data.active !== false) { S.role = m.data.role; S.name = m.data.display_name || S.user.email || ""; }
    }
  }
  async function loadBase() {
    const [cat, enz, idx] = await Promise.all([
      sb.from("phage_catalog_public").select("phage_id,lab_phage_id,phage_name,host_genus,host_species,phagesdb_cluster,phagesdb_subcluster,genome_length_bp,annotation_status,restriction_digest_image_url,virtual_digest_image_url").order("phage_name").range(0, 4999),
      sb.from("restriction_enzymes").select("*").eq("active", true).order("enzyme_name"),
      sb.from("restriction_digest_experiments").select("restriction_digest_experiment_id,phage_id,experiment_date,gel_image_path,gel_image_url,positive_control_passed,lane_layout").range(0, 9999)
    ]);
    if (cat.error) throw cat.error;
    if (enz.error) throw enz.error;
    S.catalog = cat.data || []; S.enzymes = enz.data || [];
    S.digestIndex = new Map();
    for (const x of idx.data || []) { if (!S.digestIndex.has(x.phage_id)) S.digestIndex.set(x.phage_id, []); S.digestIndex.get(x.phage_id).push(x); }
  }
  async function loadPhage(id) {
    S.phage = S.catalog.find((p) => p.phage_id === id) || null;
    S.digests = []; S.results = []; S.genome = null; S.genes = null;
    if (!S.phage) return;
    const ex = await sb.from("restriction_digest_experiments").select("*").eq("phage_id", id).order("experiment_date", { ascending: false });
    if (ex.error) throw ex.error;
    S.digests = ex.data || [];
    const ids = S.digests.map((x) => x.restriction_digest_experiment_id);
    if (ids.length) {
      const rs = await sb.from("restriction_digest_results").select("*").in("restriction_digest_experiment_id", ids);
      if (rs.error) throw rs.error;
      S.results = rs.data || [];
    }
  }
  // The phage's genome: the lab's selected assembly when there is one, else the PhagesDB FASTA through the lab's server.
  async function loadGenome() {
    if (S.genome || !S.phage) return;
    S.genome = { loading: true }; render();
    try {
      const st = await sb.from("phage_workflow_status_public").select("selected_assembly_id,assembly_label,assembly_sha256,fasta_download_url,circularized").eq("phage_id", S.phage.phage_id).maybeSingle();
      const rec = st.data || {};
      let text = "", source = "", label = "";
      if (rec.fasta_download_url) {
        const r = await fetch(rec.fasta_download_url);
        if (!r.ok) throw new Error(`The lab's genome file could not be downloaded (${r.status}).`);
        text = await r.text(); source = rec.fasta_download_url; label = rec.assembly_label || "Rudner Lab assembly";
      } else {
        const px = await sb.functions.invoke("fetch-phage-fasta", { body: { phage_id: S.phage.phage_id } });
        if (px.error || !px.data || !px.data.fasta) throw new Error((px.data && px.data.error) || "No genome sequence is available for this phage yet.");
        text = px.data.fasta; source = px.data.source_url || "PhagesDB"; label = "PhagesDB FASTA";
      }
      const f = DG.parseFasta(text);
      if (!f.seq.length) throw new Error("The genome file holds no DNA sequence.");
      S.genome = { seq: f.seq, label, source, circular: !!rec.circularized, assembly_id: rec.selected_assembly_id || null, sha256: rec.assembly_sha256 || null };
      const g = await sb.from("phage_genes_public").select("product,function").eq("phage_id", S.phage.phage_id);
      const text2 = (g.data || []).map((x) => `${x.product || ""} ${x.function || ""}`).join(" ").toLowerCase();
      S.genes = { n: (g.data || []).length, hits: DG.MOD_TERMS.filter((t) => text2.includes(t)) };
    } catch (err) {
      S.genome = { error: err.message || String(err) };
    }
    render();
  }
  async function loadControl() {
    if (S.control) return S.control;
    try {
      const r = await fetch("data/lambda.fasta");
      const f = DG.parseFasta(await r.text());
      S.control = { seq: f.seq, name: "Lambda DNA" };
    } catch (err) { S.control = { seq: "", name: "Lambda DNA", error: "The lambda sequence could not be loaded." }; }
    return S.control;
  }

  // ---------- the digest being edited ----------
  function openDigest(expId) {
    const x = expId === "new" ? null : S.digests.find((d) => d.restriction_digest_experiment_id === expId);
    const D = {
      id: x ? x.restriction_digest_experiment_id : uuid(), isNew: !x,
      date: (x && x.experiment_date) || "", ladder: (x && x.ladder) || "",
      control: x ? x.positive_control_passed : null, controlName: (x && x.control_name) || "Lambda DNA",
      gelPath: (x && x.gel_image_path) || "", controlPath: (x && x.control_image_path) || "", virtualPath: (x && x.virtual_image_path) || "",
      gelOriginal: (x && x.gel_original_url) || "", controlOriginal: (x && x.control_original_url) || "",
      legacyGelUrl: (x && x.gel_image_url) || "", lanes: [], saved: new Map(), orderText: "", orderMsg: "", showStoredVirtual: false
    };
    if (x) {
      for (const r of S.results.filter((r) => r.restriction_digest_experiment_id === D.id)) D.saved.set(r.restriction_enzyme_id, r);
      const mk = (id) => ({ id, observed: (D.saved.get(id) || {}).observed_result || "" });
      for (const t of Array.isArray(x.lane_layout) ? x.lane_layout : []) {
        if (t === "L") D.lanes.push({ sp: "ladder" }); else if (t === "U") D.lanes.push({ sp: "uncut" });
        else if (S.enzymes.some((z) => z.restriction_enzyme_id === t) && !D.lanes.some((L) => L.id === t)) D.lanes.push(mk(t));
      }
      const rest = [...D.saved.values()].sort((a, b) => (a.lane_number || 99) - (b.lane_number || 99));
      for (const r of rest) if (!D.lanes.some((L) => L.id === r.restriction_enzyme_id)) D.lanes.push(mk(r.restriction_enzyme_id));
    }
    S.D = D; S.msg = "";
    S.open = { enz: null, gel: null };
  }
  function addLane(kind) {
    const L = S.D.lanes;
    if (kind === "ladder" && !L.some((x) => x.sp === "ladder")) L.unshift({ sp: "ladder" });
    else if (kind === "uncut" && !L.some((x) => x.sp === "uncut")) L.splice(L[0] && L[0].sp === "ladder" ? 1 : 0, 0, { sp: "uncut" });
    else L.push({ sp: kind });
  }
  function toggleEnzyme(id, on) {
    const D = S.D, i = D.lanes.findIndex((L) => L.id === id);
    if (on && i < 0) D.lanes.push({ id, observed: "" });
    if (!on && i >= 0) { if (D.saved.has(id) && S.role !== "owner") { S.msg = "A saved result can't be removed here; only an owner can remove one."; return; } D.lanes.splice(i, 1); }
  }
  // ---------- images ----------
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      if (/\.tiff?$/i.test(file.name) || /tiff/i.test(file.type)) return reject(new Error("Browsers can't read TIFF files. Export the gel as JPEG or PNG and upload that."));
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, CFG.IMAGE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve({ blob: b, w: c.width, h: c.height }) : reject(new Error("The image could not be converted."))), "image/jpeg", CFG.IMAGE_QUALITY);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
      img.src = url;
    });
  }
  async function uploadImage(kind, file) {
    const D = S.D;
    S.busy = `Preparing the ${kind} image…`; render();
    try {
      const r = await resizeImage(file);
      const path = `${S.phage.phage_id}/${D.id}/${kind}-${Date.now()}.jpg`;
      S.busy = `Uploading (${Math.round(r.blob.size / 1024)} KB)…`; render();
      const up = await sb.storage.from(CFG.IMAGE_BUCKET).upload(path, r.blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      if (kind === "gel") D.gelPath = path; else if (kind === "control") D.controlPath = path; else D.virtualPath = path;
      S.msg = `Image uploaded (${r.w} × ${r.h}, ${Math.round(r.blob.size / 1024)} KB). Save to keep it with this digest.`;
    } catch (err) { S.msg = err.message || String(err); }
    S.busy = ""; render();
  }

  // ---------- save ----------
  async function save() {
    const D = S.D;
    if (!D.lanes.some((L) => !L.sp) && !D.gelPath && !D.controlPath) { S.msg = "Nothing to save yet: pick at least one enzyme or add a gel image."; render(); return; }
    const gone = [...D.saved.keys()].filter((k) => !D.lanes.some((L) => L.id === k));
    if (gone.length && S.role !== "owner") { S.msg = "A saved result can't be removed here; only an owner can remove one."; render(); return; }
    S.busy = "Saving…"; render();
    try {
      const row = {
        experiment_date: D.date || null, ladder: D.ladder || null, positive_control_passed: D.control, control_name: D.controlName || null,
        gel_image_path: D.gelPath || null, control_image_path: D.controlPath || null, virtual_image_path: D.virtualPath || null,
        gel_original_url: D.gelOriginal.trim() || null, control_original_url: D.controlOriginal.trim() || null,
        lane_layout: D.lanes.map((L) => (L.sp === "ladder" ? "L" : L.sp === "uncut" ? "U" : L.id))
      };
      const q = D.isNew
        ? sb.from("restriction_digest_experiments").insert({ restriction_digest_experiment_id: D.id, phage_id: S.phage.phage_id, ...row })
        : sb.from("restriction_digest_experiments").update(row).eq("restriction_digest_experiment_id", D.id);
      const r1 = await q;
      if (r1.error) throw r1.error;
      D.isNew = false;
      const jobs = [], fresh = [];
      D.lanes.forEach((L, i) => {
        if (L.sp || !L.observed) return;                       // a lane without a status is only planned: nothing to record yet
        const c = cutsOf(L.id);
        const pred = c ? { predicted_site_count: c.sites, predicted_fragment_sizes_bp: c.fragments, predicted_sequence_source: S.genome.source, predicted_assembly_id: S.genome.assembly_id, predicted_sequence_sha256: S.genome.sha256 } : {};
        const old = D.saved.get(L.id);
        const vals = { lane_number: i + 1, observed_result: L.observed, virtual_digest_result: virtualCall(L.id) || null, ...pred };
        if (old) jobs.push(sb.from("restriction_digest_results").update(vals).eq("restriction_digest_result_id", old.restriction_digest_result_id));
        else fresh.push({ restriction_digest_experiment_id: D.id, restriction_enzyme_id: L.id, ...vals });
      });
      if (fresh.length) jobs.push(sb.from("restriction_digest_results").insert(fresh));
      for (const k of gone) jobs.push(sb.from("restriction_digest_results").delete().eq("restriction_digest_result_id", D.saved.get(k).restriction_digest_result_id));
      const bad = (await Promise.all(jobs)).find((r) => r.error);
      if (bad) throw bad.error;
      const keepOpen = S.open, id = D.id, keepGenome = S.genome, keepGenes = S.genes;
      await loadBase(); await loadPhage(S.phage.phage_id);
      S.genome = keepGenome; S.genes = keepGenes;
      openDigest(id); S.open = keepOpen;
      const unset = S.D.lanes.filter((L) => !L.sp && !L.observed).length;
      S.msg = unset ? `Saved. ${unset} enzyme${unset === 1 ? "" : "s"} still without a result; come back to finish.` : "Saved.";
    } catch (err) { S.msg = `Not saved: ${err.message || err}`; }
    S.busy = ""; render();
  }

  // ---------- views ----------
  function viewSignIn(note) {
    return `<div class="card narrow"><h2>Sign in</h2><p class="sub">Use your Rudner Lab account, the same one as on the phage database page.</p>
      <form id="signin"><label>User name or e-mail<input name="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">Sign in</button> <span class="msg">${esc(note || "")}</span></form></div>`;
  }
  function viewNoAccess() {
    return `<div class="card narrow"><h2>No lab access</h2><p>You are signed in as ${esc(S.user.email || "")}, but this account is not a member of the lab. Ask a lab owner to add it.</p></div>`;
  }
  function listRows() {
    const F = S.filters, has = (v, f) => !f || String(v || "").toLowerCase().includes(f.trim().toLowerCase());
    const dn = (p) => (S.digestIndex.get(p.phage_id) || []).length;
    const cl = (p) => p.phagesdb_subcluster || p.phagesdb_cluster || "";
    let rows = S.catalog.filter((p) => has(p.phage_name, F.name) && has(p.lab_phage_id, F.lab) && has(`${p.host_genus || ""} ${p.host_species || ""}`, F.host) && has(cl(p), F.cluster)
      && (!F.genome || (F.genome === "yes") === !!p.genome_length_bp) && (!F.digest || (F.digest === "yes") === dn(p) > 0));
    const key = { name: (p) => (p.phage_name || "").toLowerCase(), lab: (p) => (p.lab_phage_id || "").toLowerCase(), host: (p) => (p.host_genus || "").toLowerCase(), cluster: (p) => cl(p).toLowerCase(), genome: (p) => p.genome_length_bp || 0, digest: dn }[S.sort.k];
    rows = rows.slice().sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir || (a.phage_name || "").localeCompare(b.phage_name || ""); });
    return rows;
  }
  function viewList() {
    const rows = listRows(), F = S.filters, n = S.pageSize, pages = Math.max(1, Math.ceil(rows.length / n));
    S.page = Math.min(S.page, pages - 1);
    const shown = rows.slice(S.page * n, S.page * n + n);
    const th = (k, label) => `<th data-sort="${k}" title="Sort by this column">${label} <span class="arrow">${S.sort.k === k ? (S.sort.dir > 0 ? "▲" : "▼") : ""}</span></th>`;
    const tf = (k, ph) => `<td><input data-lf="${k}" value="${esc(F[k])}" placeholder="${ph}"></td>`;
    const sf = (k, yes, no) => `<td><select data-lf="${k}"><option value="">all</option><option value="yes"${F[k] === "yes" ? " selected" : ""}>${yes}</option><option value="no"${F[k] === "no" ? " selected" : ""}>${no}</option></select></td>`;
    const pager = `<div class="row pager"><label class="check">Rows <select id="pagesize">${[15, 25, 50, 100].map((v) => `<option${v === n ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      <button data-page="-1"${S.page ? "" : " disabled"}>◀ Previous</button><span class="sub">Page ${S.page + 1} of ${pages} · ${fmt(rows.length)} of ${fmt(S.catalog.length)} phages</span><button data-page="1"${S.page < pages - 1 ? "" : " disabled"}>Next ▶</button>
      ${Object.values(F).some(Boolean) ? '<button data-act="clearfilters">Clear filters</button>' : ""}</div>`;
    return `<div class="card"><h2>Phages</h2>${pager}
      <table class="list sortable"><thead><tr>${th("name", "Phage")}${th("lab", "Lab ID")}${th("host", "Host")}${th("cluster", "Cluster")}${th("genome", "Genome")}${th("digest", "Restriction digests")}</tr>
      <tr class="filters">${tf("name", "filter")}${tf("lab", "filter")}${tf("host", "filter")}${tf("cluster", "filter")}${sf("genome", "has a sequence", "no sequence")}${sf("digest", "has a digest", "none yet")}</tr></thead><tbody>
      ${shown.map((p) => { const d = S.digestIndex.get(p.phage_id) || []; return `<tr data-go="#/phage/${p.phage_id}"><td><b>${esc(p.phage_name || "")}</b></td><td>${esc(p.lab_phage_id || "")}</td><td>${esc(p.host_genus || "")}</td><td>${esc(p.phagesdb_subcluster || p.phagesdb_cluster || "")}</td><td>${p.genome_length_bp ? fmt(p.genome_length_bp) + " bp" : '<span class="sub">no sequence</span>'}</td><td>${d.length ? chip(`${d.length} digest${d.length === 1 ? "" : "s"}`, "ok") : chip("none", "mute")}</td></tr>`; }).join("") || '<tr><td colspan="6" class="sub">No phage matches these filters.</td></tr>'}
      </tbody></table>${pager}</div>`;
  }
  function viewEnzymes() {
    return `<p><a href="#/">← All phages</a></p><div class="card"><h2>Enzyme details</h2>
      <p class="sub">The restriction enzymes in the lab's catalogue. This page is the same for every phage; the number of cuts and the predicted fragments depend on the genome and are shown on each digest.</p>
      <table class="list"><thead><tr><th>Enzyme</th><th>Recognition sequence</th><th>Cut</th><th>Sensitivity to DNA modification</th><th>Diagnostic group</th><th>Notes</th></tr></thead><tbody>
      ${S.enzymes.map((z) => `<tr><td><b>${esc(z.enzyme_name)}</b></td><td class="mono">${esc(z.recognition_sequence)}</td><td>${esc(z.cut_description || "")}</td><td>${esc(z.modification_sensitivity || "")}</td><td>${esc(z.diagnostic_group || "")}</td><td class="tiny">${esc(z.notes || "")}</td></tr>`).join("")}
      </tbody></table></div>`;
  }
  function viewPhage() {
    const p = S.phage;
    return `<p><a href="#/">← All phages</a></p>
      <div class="card"><h2>${esc(p.phage_name)} <span class="sub">${esc(p.lab_phage_id || "")}</span></h2>
      <p class="sub">${esc([p.host_genus, p.host_species].filter(Boolean).join(" "))}${p.phagesdb_cluster ? " · Cluster " + esc(p.phagesdb_subcluster || p.phagesdb_cluster) : ""}${p.genome_length_bp ? " · " + fmt(p.genome_length_bp) + " bp" : " · no genome sequence yet"}</p>
      ${phageGel() || phageVirtual() ? `<div class="two">${phageGel() ? `<div class="imgbox"><b>Digest image from ${srcName(phageGel())}</b><a href="${esc(phageGel())}" target="_blank" rel="noopener"><img src="${esc(phageGel())}" alt="Restriction digest"></a></div>` : ""}${phageVirtual() ? `<div class="imgbox"><b>Virtual digest image from ${srcName(phageVirtual())}</b><a href="${esc(phageVirtual())}" target="_blank" rel="noopener"><img src="${esc(phageVirtual())}" alt="Virtual digest"></a></div>` : ""}</div>` : ""}
      <div class="row"><h3 style="margin:0">Restriction digests</h3><a class="btn primary" href="#/phage/${p.phage_id}/digest/new">+ New digest</a></div>
      ${S.digests.length ? `<table class="list"><thead><tr><th>Date</th><th>Lanes</th><th>Plan</th><th>Lab gel</th><th>Compared</th><th>Blocked</th></tr></thead><tbody>${S.digests.map((x) => {
        const st = stageOf(x, S.results); st.lab = st.lab || !!phageGel(); const rs = S.results.filter((r) => r.restriction_digest_experiment_id === x.restriction_digest_experiment_id);
        const lanes = (Array.isArray(x.lane_layout) ? x.lane_layout : []).map((t) => (t === "L" ? "ladder" : t === "U" ? "uncut" : enzyme(t).enzyme_name || "?"));
        const blk = rs.filter((r) => (r.virtual_digest_result || (r.predicted_site_count > 0 ? "Digestion" : "")) === "Digestion" && r.observed_result === "No digestion").map((r) => enzyme(r.restriction_enzyme_id).enzyme_name);
        const yes = chip("done", "ok"), no = chip("to do", "mute");
        return `<tr data-go="#/phage/${p.phage_id}/digest/${x.restriction_digest_experiment_id}"><td>${esc(x.experiment_date || "no date")}</td><td>${esc(lanes.join(" · ") || rs.map((r) => enzyme(r.restriction_enzyme_id).enzyme_name).join(" · "))}</td><td>${st.planned ? yes : no}</td><td>${st.lab ? yes : no}</td><td>${st.compared ? yes : no}</td><td>${blk.length ? chip(blk.join(", "), x.positive_control_passed === true ? "bad" : "warn") + (x.positive_control_passed === true ? "" : ' <span class="sub">control not passed</span>') : ""}</td></tr>`;
      }).join("")}</tbody></table>` : '<p class="sub">No digests recorded for this phage yet.</p>'}
      </div>`;
  }

  function virtualGel() {
    const D = S.D;
    if (!S.genome || !S.genome.seq) return "";
    if (!D.lanes.length) return '<p class="sub">The predicted bands appear here once a lane is added.</p>';
    const lanes = D.lanes.map((L) => (L.sp === "ladder" ? { label: "Ladder", kind: "ladder" } : L.sp === "uncut" ? { label: "Uncut", kind: "bands", fragments: [S.genome.seq.length] } : { label: laneName(L), kind: "bands", fragments: cutsOf(L.id).fragments }));
    if (!D.lanes.some((L) => L.sp === "ladder")) lanes.unshift({ label: "Ladder", kind: "ladder" });
    return `<div class="gelscroll">${DG.gelSvg(lanes)}</div>${D.lanes.some((L) => L.sp === "ladder") ? "" : '<p class="tiny">A 1 kb ladder is drawn first for scale; it is not one of your lanes.</p>'}`;
  }
  function genomeBox() {
    const g = S.genome;
    if (!g || g.loading) return '<p class="sub">Reading the genome…</p>';
    if (g.error) return `<div class="note warn"><b>No virtual digest yet.</b> ${esc(g.error)} You can still record the lab digest now and come back when the sequence is available.</div>`;
    return `<p class="sub">Genome: ${esc(g.label)} · ${fmt(g.seq.length)} bp · ${g.circular ? "circular" : "linear"}.${S.genes ? (S.genes.n ? (S.genes.hits.length ? ` <span class="chip warn">DNA-modification genes annotated: ${esc(S.genes.hits.join(", "))}</span>` : " No DNA-modification genes found in the annotation.") : " The genome is not annotated yet, so modification genes can't be checked.") : ""}</p>`;
  }
  function imageBox(kind, title, path, legacy) {
    const own = publicUrl(path), url = own || legacy || "";
    const from = !own && url ? `<p class="tiny">Showing the image from ${srcName(url)}. Upload one only if this digest has its own gel.</p>` : "";
    return `<div class="imgbox"><div class="row"><b>${title}</b><label class="btn">${url ? "Replace image" : "Upload image"}<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="${kind}" hidden></label></div>
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${title}"></a>${from}` : '<div class="empty">No image yet. JPEG or PNG; it is resized before upload.</div>'}</div>`;
  }

  // Compact picker: Ladder and Uncut first, then every enzyme with its number of cuts in this genome.
  function enzymePicker() {
    const D = S.D, g = S.genome && S.genome.seq, last = D.lanes.length - 1;
    const box = (attr, on, label, title, lock) => `<label class="pick${on ? " on" : ""}" title="${esc(title || "")}"><input type="checkbox" ${attr}${on ? " checked" : ""}${lock ? " disabled" : ""}>${label}</label>`;
    const enz = S.enzymes.map((z) => {
      const c = g ? DG.digest(S.genome.seq, z.recognition_sequence, S.genome.circular) : null;
      const lock = D.saved.has(z.restriction_enzyme_id) && S.role !== "owner";
      const tip = `${z.recognition_sequence}${c ? (c.sites ? ` · fragments: ${c.fragments.slice(0, 8).map(fmt).join(", ")}${c.fragments.length > 8 ? " …" : ""} bp` : " · no sites in this genome") : ""}${lock ? " · has a saved result" : ""}`;
      return box(`data-pick="${z.restriction_enzyme_id}"`, D.lanes.some((L) => L.id === z.restriction_enzyme_id), `${esc(z.enzyme_name)}${c ? ` <span class="n">(${c.sites})</span>` : ""}`, tip, lock);
    }).join("");
    const order = D.lanes.length ? `<div class="order"><span class="sub">Lane order:</span>${D.lanes.map((L, i) => `<span class="ord${L.sp ? " sp" : ""}"><button class="mini" data-move="${i}" data-dir="-1"${i ? "" : " disabled"} title="Move one lane to the left on the gel">◀</button><b>${i + 1}</b> ${esc(laneName(L))}<button class="mini" data-move="${i}" data-dir="1"${i < last ? "" : " disabled"} title="Move one lane to the right on the gel">▶</button></span>`).join("")}<button class="mini" data-add="ladder" title="Add another ladder lane at the end">+ ladder</button></div>` : "";
    return `<div class="picks">${box('data-sp="ladder"', D.lanes.some((L) => L.sp === "ladder"), "Ladder", "A ladder lane; it goes in lane 1")}${box('data-sp="uncut"', D.lanes.some((L) => L.sp === "uncut"), "Uncut", "A lane of uncut DNA")}${enz}</div>
      ${g ? "" : '<p class="tiny">The number of cuts appears once the genome sequence is available.</p>'}${order}
      <p class="tiny"><a href="#/enzymes" target="_blank" rel="noopener">Enzyme details</a> (recognition sequences and modification sensitivity) open in a new tab. Hover over an enzyme to see its predicted fragments in this phage.</p>`;
  }
  const CALL_BTN = [["Digestion", "✓", "ok", "Digests: the lab gel shows the enzyme cut the DNA"], ["Partial digestion", "~", "warn", "Partial digestion: some DNA cut, some left uncut"], ["No digestion", "✗", "bad", "Does not digest: the DNA is uncut in the lab gel"], ["Uninterpretable", "?", "mute", "Undetermined: the lane cannot be read"]];
  // The chosen lanes in gel order; under each enzyme, one click records what the lab gel shows.
  function laneStrip() {
    const D = S.D;
    if (!D.lanes.length) return '<div class="note warn">No enzymes chosen yet. Open <b>Restriction enzymes</b> above to choose them and put them in gel order.</div>';
    return `<div class="strip">${D.lanes.map((L, i) => {
      if (L.sp) return `<div class="lanecard sp"><div class="ln">${i + 1}</div><div class="nm">${laneName(L)}</div></div>`;
      const c = cutsOf(L.id), v = virtualCall(L.id);
      const verdict = !L.observed ? '<span class="t-warn">not set</span>' : !v ? "&nbsp;" : isBlocked(L) ? '<b class="t-bad">blocked</b>' : v === L.observed ? '<span class="t-ok">as predicted</span>' : L.observed === "Partial digestion" ? '<span class="t-warn">partial</span>' : L.observed === "Uninterpretable" ? '<span class="sub">unclear</span>' : '<span class="t-warn">differs</span>';
      return `<div class="lanecard${isBlocked(L) ? " blk" : ""}"><div class="ln">${i + 1}</div><div class="nm" title="${esc(enzyme(L.id).recognition_sequence || "")}">${esc(laneName(L))}</div>
        <div class="st" title="${c ? (c.sites ? "Recognition sites in this genome" : "No sites in this genome: this lane should stay uncut") : "No genome sequence yet"}">${c ? `${c.sites} site${c.sites === 1 ? "" : "s"}` : "&nbsp;"}</div>
        <div class="cb">${CALL_BTN.map((k) => `<button class="call ${L.observed === k[0] ? "on " + k[2] : L.observed ? "" : "unset"}" data-call="${i}" data-val="${k[0]}" title="${k[3]}" aria-label="${k[0]}">${k[1]}</button>`).join("")}</div>
        <div class="vd">${verdict}</div></div>`;
    }).join("")}</div>`;
  }
  function gelDetails() {
    const D = S.D;
    return `<div class="row fields">
        <label>Date of the digest<input type="date" data-f="date" value="${esc(D.date)}"></label>
        <label>Ladder<select data-f="ladder"><option value="">— not recorded —</option>${CFG.LADDERS.concat(D.ladder && !CFG.LADDERS.includes(D.ladder) ? [D.ladder] : []).map((l) => `<option${l === D.ladder ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      </div>
      <div class="two">
        <div>${imageBox("gel", "Lab digest image", D.gelPath, D.legacyGelUrl || phageGel())}
          <label class="full">Link to the full-size original (SharePoint / OneDrive) <span class="sub">— lab members only</span><input type="url" data-f="gelOriginal" value="${esc(D.gelOriginal)}" placeholder="https://…"></label></div>
        <div>${imageBox("control", "Control digest image (optional)", D.controlPath, "")}
          <label class="full">Link to the full-size original of the control <span class="sub">— lab members only</span><input type="url" data-f="controlOriginal" value="${esc(D.controlOriginal)}" placeholder="https://…"></label>
          <label>Control DNA<input data-f="controlName" value="${esc(D.controlName)}"></label>
          <div id="controlgel">${controlGel()}</div></div>
      </div>`;
  }
  function controlGel() {
    const D = S.D, c = S.control;
    if (!c) return '<button data-act="control">Show the expected control digest (lambda)</button>';
    if (!c.seq) return `<p class="t-warn">${esc(c.error || "No control sequence.")}</p>`;
    const enz = D.lanes.filter((L) => !L.sp);
    return `<p class="sub">Expected: ${esc(c.name)} (${fmt(c.seq.length)} bp) cut with the same enzymes.</p>
      ${enz.length ? `<div class="gelscroll">${DG.gelSvg([{ label: "Ladder", kind: "ladder" }].concat(enz.map((L) => ({ label: laneName(L), kind: "bands", fragments: DG.digest(c.seq, enzyme(L.id).recognition_sequence, false).fragments }))), { height: 220 })}</div>` : '<p class="sub">Add enzymes to see their expected control pattern.</p>'}
      <label class="btn">Use a different control sequence (FASTA file)<input type="file" accept=".fasta,.fa,.fna,.txt" data-controlfasta hidden></label>`;
  }
  function viewDigest() {
    const D = S.D, p = S.phage;
    const enz = D.lanes.filter((L) => !L.sp), unset = enz.filter((L) => !L.observed).length;
    const ownGel = publicUrl(D.gelPath) || D.legacyGelUrl, gel = ownGel || phageGel(), g = S.genome && S.genome.seq;
    const openEnz = S.open.enz == null ? !D.lanes.length : S.open.enz, openGel = S.open.gel == null ? false : S.open.gel;
    const anyBlocked = D.lanes.some(isBlocked);
    return `<p><a href="#/phage/${p.phage_id}">← ${esc(p.phage_name)}</a></p>
      <div class="card"><h2>${D.isNew ? "New digest" : "Digest"} · ${esc(p.phage_name)} <span class="sub">${esc(D.date || "")}</span></h2>
      ${genomeBox()}
      <details class="sec" data-sec="enz"${openEnz ? " open" : ""}><summary><b>Restriction enzymes</b> <span class="sub">${D.lanes.length ? `${D.lanes.length} lane${D.lanes.length === 1 ? "" : "s"}: ${esc(D.lanes.map(laneName).join(" · "))}` : "tick the lanes on the gel and put them in order"}</span></summary>${enzymePicker()}</details>
      <h4>Result for each enzyme</h4>
      ${laneStrip()}
      ${anyBlocked && D.control !== true ? '<div class="note bad">A lane is <b>blocked</b> (the genome has sites but the gel shows no cut). Blocked results are only counted when the control digested as expected: answer that beside Save.</div>' : ""}
      <div class="two gels">
        <div><b>Lab digest</b>${gel && !ownGel ? ` <span class="sub">from ${srcName(gel)}</span>` : ""}${gel ? `<a href="${esc(gel)}" target="_blank" rel="noopener"><img class="big" src="${esc(gel)}" alt="Lab digest"></a>` : '<div class="empty">No lab digest image yet. Add one under <b>Gel image, date and control</b> below.</div>'}
          ${D.gelOriginal ? `<p class="tiny"><a href="${esc(D.gelOriginal)}" target="_blank" rel="noopener">Open the full-size original</a> (lab members only)</p>` : ""}</div>
        <div><b>Virtual digest</b> <span class="sub">from the DNA sequence, same lane order</span>${g ? virtualGel() : `<div class="empty">${S.genome && S.genome.loading ? "Reading the genome…" : "No genome sequence yet, so no virtual digest. Results can still be recorded now and compared later."}</div>`}</div>
      </div>
      <details class="sec" data-sec="gel"${openGel ? " open" : ""}><summary><b>Gel image, date and control</b> <span class="sub">${[D.date || "no date", ownGel ? "own gel image" : gel ? `gel from ${srcName(gel)}` : "no gel image", D.controlPath ? "control image" : ""].filter(Boolean).join(" · ")}</span></summary>${gelDetails()}</details>
      <div class="savebar"><span>Did the control digest as expected? <span class="seg">${[["true", "Yes"], ["false", "No"]].map((o) => `<button data-control="${o[0]}" class="${String(D.control) === o[0] ? "on" : ""}">${o[1]}</button>`).join("")}</span></span>
        <button class="primary" data-act="save"${S.busy ? " disabled" : ""}>Save</button>
        <span class="msg">${esc(S.busy || S.msg || (enz.length ? `${D.lanes.length} lane${D.lanes.length === 1 ? "" : "s"} · ${enz.length} enzyme${enz.length === 1 ? "" : "s"}${unset ? ` · ${unset} without a result` : ""}` : ""))}</span></div>
      </div>`;
  }

  // ---------- render and routing ----------
  let route = { name: "list" };
  function render() {
    const ae = document.activeElement, keepKey = ae && ae.dataset && ae.dataset.lf && ae.tagName === "INPUT" ? ae.dataset.lf : null, keep = keepKey ? ae.selectionStart : null;
    userBox.innerHTML = S.user ? `${esc(S.name || S.user.email || "")}${S.role ? ` · ${esc(S.role)}` : ""} <button id="signout">Sign out</button>` : "";
    if (!S.user) app.innerHTML = viewSignIn(S.msg);
    else if (!S.role || S.role === "viewer") app.innerHTML = viewNoAccess();
    else if (route.name === "digest" && S.D) app.innerHTML = viewDigest();
    else if (route.name === "phage" && S.phage) app.innerHTML = viewPhage();
    else if (route.name === "enzymes") app.innerHTML = viewEnzymes();
    else app.innerHTML = viewList();
    if (keepKey) { const f = app.querySelector(`input[data-lf="${keepKey}"]`); if (f) { f.focus(); f.setSelectionRange(keep, keep); } }
  }
  async function go() {
    const h = location.hash.replace(/^#\/?/, "").split("/");
    try {
      if (!S.user || !S.role) { render(); return; }
      if (!S.catalog.length) await loadBase();
      if (h[0] === "enzymes") { S.D = null; route = { name: "enzymes" }; render(); return; }
      if (h[0] === "phage" && h[1]) {
        if (!S.phage || S.phage.phage_id !== h[1]) await loadPhage(h[1]);
        if (!S.phage) { location.hash = "#/"; return; }
        if (h[2] === "digest" && h[3]) {
          if (!S.D || (h[3] !== "new" && S.D.id !== h[3]) || (h[3] === "new" && !S.D.isNew)) openDigest(h[3]);
          route = { name: "digest" }; render(); loadGenome(); return;
        }
        S.D = null; route = { name: "phage" }; render(); return;
      }
      S.D = null; route = { name: "list" };
      const want = new URLSearchParams(location.search).get("phage");
      if (want && !go.usedParam) { go.usedParam = true; const p = S.catalog.find((x) => norm(x.phage_name) === norm(want)); if (p) { location.hash = `#/phage/${p.phage_id}`; return; } }
      render();
    } catch (err) { app.innerHTML = `<div class="card narrow"><h2>Something went wrong</h2><p>${esc(err.message || err)}</p></div>`; }
  }

  // ---------- events ----------
  document.addEventListener("submit", async (ev) => {
    if (ev.target.id !== "signin") return;
    ev.preventDefault();
    const f = new FormData(ev.target);
    let email = String(f.get("email") || "").trim();
    if (email && !email.includes("@")) email = `${email.toLowerCase()}@${CFG.LOGIN_DOMAIN}`;
    S.msg = "Signing in…"; render();
    const r = await sb.auth.signInWithPassword({ email, password: String(f.get("password") || "") });
    S.msg = r.error ? "That user name and password were not accepted." : "";
    await loadSession(); go();
  });
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("button, a.btn, th[data-sort], tr[data-go]");
    if (!t) return;
    if (t.dataset.sort) { S.sort = { k: t.dataset.sort, dir: S.sort.k === t.dataset.sort ? -S.sort.dir : 1 }; S.page = 0; render(); return; }
    if (t.dataset.page) { S.page = Math.max(0, S.page + Number(t.dataset.page)); render(); return; }
    if (t.dataset.act === "clearfilters") { for (const k in S.filters) S.filters[k] = ""; S.page = 0; render(); return; }
    if (t.id === "signout") { await sb.auth.signOut(); S.user = null; S.role = null; S.catalog = []; S.phage = null; S.D = null; render(); return; }
    if (t.dataset.go) { location.hash = t.dataset.go; return; }
    const D = S.D;
    if (!D) return;
    if (t.dataset.act === "save") { save(); return; }
    if (t.dataset.act === "control") { await loadControl(); render(); return; }
    if (t.dataset.act === "togglevirtual") { D.showStoredVirtual = !D.showStoredVirtual; render(); return; }
    if (t.dataset.add) { addLane(t.dataset.add); render(); return; }
    if (t.dataset.control) { D.control = t.dataset.control === "true"; S.msg = ""; render(); return; }
    if (t.dataset.call !== undefined) { const L = D.lanes[Number(t.dataset.call)]; if (L && !L.sp) { L.observed = t.dataset.val; S.msg = ""; render(); } return; }
    if (t.dataset.move !== undefined) { const i = Number(t.dataset.move), j = i + Number(t.dataset.dir); if (j >= 0 && j < D.lanes.length) { const x = D.lanes[i]; D.lanes[i] = D.lanes[j]; D.lanes[j] = x; render(); } return; }
    if (t.dataset.drop !== undefined) { const L = D.lanes[Number(t.dataset.drop)]; if (L && L.sp) D.lanes.splice(Number(t.dataset.drop), 1); else if (L) toggleEnzyme(L.id, false); render(); return; }
  });
  document.addEventListener("change", async (ev) => {
    const t = ev.target, D = S.D;
    if (t.id === "pagesize") { S.pageSize = Number(t.value) || 25; S.page = 0; render(); return; }
    if (t.dataset.lf && t.tagName === "SELECT") { S.filters[t.dataset.lf] = t.value; S.page = 0; render(); return; }
    if (!D) return;
    if (t.dataset.pick) { toggleEnzyme(t.dataset.pick, t.checked); render(); return; }
    if (t.dataset.sp) { if (t.checked) addLane(t.dataset.sp); else D.lanes = D.lanes.filter((L) => L.sp !== t.dataset.sp); render(); return; }
    if (t.dataset.f) { D[t.dataset.f] = t.value; return; }
    if (t.dataset.upload && t.files[0]) { uploadImage(t.dataset.upload, t.files[0]); return; }
    if (t.dataset.controlfasta !== undefined && t.files[0]) {
      const f = DG.parseFasta(await t.files[0].text());
      if (f.seq.length < 100) { S.msg = "No DNA sequence was found in that file."; } else { S.control = { seq: f.seq, name: f.name || t.files[0].name }; D.controlName = S.control.name.slice(0, 80); }
      render();
    }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.dataset && ev.target.dataset.lf && ev.target.tagName === "INPUT") { S.filters[ev.target.dataset.lf] = ev.target.value; S.page = 0; render(); }
    else if (ev.target.dataset && ev.target.dataset.f && S.D) S.D[ev.target.dataset.f] = ev.target.value;
  });
  document.addEventListener("toggle", (ev) => { const k = ev.target.dataset && ev.target.dataset.sec; if (k) S.open[k] = ev.target.open; }, true);
  window.addEventListener("hashchange", go);

  (async function start() {
    app.innerHTML = '<p class="sub">Loading…</p>';
    await loadSession();
    go();
  })();
})();
