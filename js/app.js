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
    D: null, step: "plan", msg: "", busy: "", listFilter: "", listNeed: false,
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
  const phageVirtual = () => (S.phage && S.phage.virtual_digest_image_url) || "";
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
    S.step = !x ? "plan" : D.gelPath || D.legacyGelUrl || phageGel() ? "compare" : "lab";
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
  // "1Kb Ladder, Uncut, BamH1, Sal1 ..." -> lanes. Gel-style spellings (BamH1) are accepted; unknown names are reported.
  function setOrder(text) {
    const D = S.D;
    const toks = String(text || "").replace(/(\d+\s*k?b?p?\s*)?(ladder|marker)/gi, " ladder ").split(/[,;\s]+/).filter(Boolean);
    const out = [], bad = [];
    for (const t of toks) {
      const k = norm(t);
      if (k === "ladder") { out.push({ sp: "ladder" }); continue; }
      if (k === "uncut" || k === "undigested") { out.push({ sp: "uncut" }); continue; }
      const z = S.enzymes.find((y) => norm(y.enzyme_name) === k) || S.enzymes.find((y) => norm(y.enzyme_name) === k.replace(/1/g, "i"));
      if (!z) { bad.push(t); continue; }
      if (out.some((L) => L.id === z.restriction_enzyme_id)) continue;
      out.push(D.lanes.find((L) => L.id === z.restriction_enzyme_id) || { id: z.restriction_enzyme_id, observed: "" });
    }
    if (!out.length) { D.orderMsg = "No lane names were recognized."; return; }
    if (S.role !== "owner") for (const k of D.saved.keys()) if (!out.some((L) => L.id === k)) out.push(D.lanes.find((L) => L.id === k) || { id: k, observed: D.saved.get(k).observed_result || "" });
    D.lanes = out; D.orderText = text;
    D.orderMsg = bad.length ? `Not recognized: ${bad.join(", ")}. Tick those in the list.` : "";
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
      const keepStep = S.step, id = D.id, keepGenome = S.genome, keepGenes = S.genes;
      await loadBase(); await loadPhage(S.phage.phage_id);
      S.genome = keepGenome; S.genes = keepGenes;
      openDigest(id); S.step = keepStep;
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
  function viewList() {
    const f = S.listFilter.trim().toLowerCase();
    let rows = S.catalog.filter((p) => !f || `${p.phage_name} ${p.lab_phage_id} ${p.host_genus} ${p.phagesdb_cluster}`.toLowerCase().includes(f));
    if (S.listNeed) rows = rows.filter((p) => !(S.digestIndex.get(p.phage_id) || []).length);
    const shown = rows.slice(0, 200);
    return `<div class="card"><h2>Phages</h2>
      <div class="row"><input id="filter" placeholder="Search by name, lab ID, host or cluster" value="${esc(S.listFilter)}" style="flex:1 1 280px">
      <label class="check"><input type="checkbox" id="need"${S.listNeed ? " checked" : ""}> only phages with no digest yet</label></div>
      <p class="sub">${fmt(rows.length)} of ${fmt(S.catalog.length)} phages${rows.length > shown.length ? `, first ${shown.length} shown` : ""}.</p>
      <table class="list"><thead><tr><th>Phage</th><th>Lab ID</th><th>Host</th><th>Cluster</th><th>Genome</th><th>Restriction digests</th></tr></thead><tbody>
      ${shown.map((p) => { const d = S.digestIndex.get(p.phage_id) || []; const st = d.map((x) => stageOf(x, null)); return `<tr data-go="#/phage/${p.phage_id}"><td><b>${esc(p.phage_name || "")}</b></td><td>${esc(p.lab_phage_id || "")}</td><td>${esc(p.host_genus || "")}</td><td>${esc(p.phagesdb_subcluster || p.phagesdb_cluster || "")}</td><td>${p.genome_length_bp ? fmt(p.genome_length_bp) + " bp" : '<span class="sub">no sequence</span>'}</td><td>${d.length ? chip(`${d.length} digest${d.length === 1 ? "" : "s"}`, st.some((s) => s.lab) ? "ok" : "warn") : chip("none", "mute")}</td></tr>`; }).join("")}
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

  function lanesTable(withCalls) {
    const D = S.D, last = D.lanes.length - 1;
    if (!D.lanes.length) return '<p class="sub">No lanes yet.</p>';
    return `<table class="lanes"><thead><tr><th>Lane</th><th>In the lane</th><th>Sites</th>${withCalls ? "<th>Virtual</th><th>Lab result</th><th></th>" : "<th></th>"}</tr></thead><tbody>${D.lanes.map((L, i) => {
      const mv = `<button class="mini" data-move="${i}" data-dir="-1"${i ? "" : " disabled"} title="Move left on the gel">◀</button> <b>${i + 1}</b> <button class="mini" data-move="${i}" data-dir="1"${i < last ? "" : " disabled"} title="Move right on the gel">▶</button>`;
      if (L.sp) return `<tr class="sp"><td>${mv}</td><td colspan="${withCalls ? 4 : 2}">${laneName(L)}</td><td><button class="mini" data-drop="${i}" title="Remove this lane">✕</button></td></tr>`;
      const c = cutsOf(L.id), v = virtualCall(L.id);
      const sites = c ? c.sites : (D.saved.get(L.id) || {}).predicted_site_count;
      if (!withCalls) return `<tr><td>${mv}</td><td><b>${esc(laneName(L))}</b></td><td>${sites == null ? "—" : sites}</td><td>${D.saved.has(L.id) && S.role !== "owner" ? "" : `<button class="mini" data-drop="${i}" title="Remove this lane">✕</button>`}</td></tr>`;
      const verdict = !L.observed ? '<span class="t-warn">not set</span>' : !v ? "" : isBlocked(L) ? '<b class="t-bad">blocked</b>' : v === L.observed ? '<span class="t-ok">as predicted</span>' : L.observed === "Partial digestion" ? '<span class="t-warn">partial</span>' : L.observed === "Uninterpretable" ? '<span class="sub">unclear</span>' : '<span class="t-warn">differs</span>';
      return `<tr><td>${mv}</td><td><b>${esc(laneName(L))}</b></td><td>${sites == null ? "—" : sites}</td><td>${esc(v || "—")}${c && !c.sites ? '<div class="tiny">0 sites: should stay uncut</div>' : ""}</td><td class="calls">${CALLS.map((k) => `<button class="call ${L.observed === k[0] ? "on " + k[2] : L.observed ? "" : "unset"}" data-call="${i}" data-val="${k[0]}">${k[1]}</button>`).join("")}</td><td>${verdict}</td></tr>`;
    }).join("")}</tbody></table>`;
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

  function stepPlan() {
    const D = S.D, g = S.genome && S.genome.seq;
    const rows = S.enzymes.map((z) => {
      const c = g ? DG.digest(S.genome.seq, z.recognition_sequence, S.genome.circular) : null;
      const u = c ? DG.usefulness(c.sites) : null, on = D.lanes.some((L) => L.id === z.restriction_enzyme_id);
      const lock = D.saved.has(z.restriction_enzyme_id) && S.role !== "owner";
      return { z, c, u, on, lock };
    });
    if (g) rows.sort((a, b) => b.u.score - a.u.score || a.z.enzyme_name.localeCompare(b.z.enzyme_name));
    const diag = S.genes && S.genes.hits.length;
    return `<h3>1 · Plan: choose the enzymes</h3>${genomeBox()}
      <table class="list plan"><thead><tr><th></th><th>Enzyme</th><th>Recognition</th><th>Sites</th><th>Predicted fragments (bp)</th><th>Use</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.on ? "sel" : ""}"><td><input type="checkbox" data-pick="${r.z.restriction_enzyme_id}"${r.on ? " checked" : ""}${r.lock ? ' disabled title="Already has a saved result"' : ""}></td><td><b>${esc(r.z.enzyme_name)}</b></td><td class="mono">${esc(r.z.recognition_sequence)}</td><td>${r.c ? r.c.sites : "—"}</td><td class="tiny">${r.c ? (r.c.sites ? r.c.fragments.slice(0, 8).map(fmt).join(", ") + (r.c.fragments.length > 8 ? " …" : "") : "uncut") : ""}</td><td class="tiny">${r.u ? esc(r.u.note) : ""}${r.z.modification_sensitivity ? `<div>${esc(r.z.modification_sensitivity)}</div>` : ""}${diag && r.z.diagnostic_group ? `<div class="t-warn">Diagnostic for DNA modification (${esc(r.z.diagnostic_group)})</div>` : ""}</td></tr>`).join("")}
      </tbody></table>
      <h4>Virtual digest of the chosen enzymes</h4>${g ? virtualGel() : '<p class="sub">Shown once a genome sequence is available.</p>'}
      ${imageBox("virtual", "Virtual digest image (optional)", D.virtualPath, phageVirtual())}`;
  }
  function stepLab() {
    const D = S.D;
    return `<h3>2 · Lab: the gel and its lanes</h3>
      <div class="row fields">
        <label>Date of the digest<input type="date" data-f="date" value="${esc(D.date)}"></label>
        <label>Ladder<select data-f="ladder"><option value="">— not recorded —</option>${CFG.LADDERS.concat(D.ladder && !CFG.LADDERS.includes(D.ladder) ? [D.ladder] : []).map((l) => `<option${l === D.ladder ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      </div>
      <div class="two">
        <div>${imageBox("gel", "Lab digest", D.gelPath, D.legacyGelUrl || phageGel())}
          <label class="full">Link to the full-size original (SharePoint / OneDrive) <span class="sub">— lab members only</span><input type="url" data-f="gelOriginal" value="${esc(D.gelOriginal)}" placeholder="https://…"></label></div>
        <div><b>Lanes, in gel order</b>
          <div class="row"><input id="order" value="${esc(D.orderText)}" placeholder="Type them as printed on the gel: ladder, uncut, BamHI, SalI, …" style="flex:1 1 240px"><button data-act="order">Set lanes</button></div>
          ${D.orderMsg ? `<p class="t-warn tiny">${esc(D.orderMsg)}</p>` : ""}
          <div class="row"><button data-add="ladder">+ Ladder lane</button><button data-add="uncut">+ Uncut DNA lane</button><span class="sub">Enzymes are ticked in step 1, or typed above.</span></div>
          ${lanesTable(false)}</div>
      </div>
      <h4>Control digest <span class="sub">(optional)</span></h4>
      <div class="two">
        <div>${imageBox("control", "Control digest", D.controlPath, "")}
          <label class="full">Link to the full-size original <span class="sub">— lab members only</span><input type="url" data-f="controlOriginal" value="${esc(D.controlOriginal)}" placeholder="https://…"></label></div>
        <div><div class="row fields"><label>Control DNA<input data-f="controlName" value="${esc(D.controlName)}"></label>
          <label>Did the control digest as expected?<span class="seg">${[["true", "Yes"], ["false", "No"]].map((o) => `<button data-control="${o[0]}" class="${String(D.control) === o[0] ? "on" : ""}">${o[1]}</button>`).join("")}</span></label></div>
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
  function stepCompare() {
    const D = S.D, ownGel = publicUrl(D.gelPath) || D.legacyGelUrl, gel = ownGel || phageGel(), stored = publicUrl(D.virtualPath) || phageVirtual();
    const g = S.genome && S.genome.seq;
    const anyBlocked = D.lanes.some(isBlocked);
    const showStored = stored && (D.showStoredVirtual || !g);
    return `<h3>3 · Compare: lab against virtual</h3>
      ${!gel ? '<div class="note warn">No lab gel image yet. Add it in step 2; you can still enter results from the gel in front of you.</div>' : ""}
      ${genomeBox()}
      <div class="two">
        <div><b>Lab digest</b>${gel && !ownGel ? ` <span class="sub">from ${srcName(gel)}</span>` : ""}${gel ? `<a href="${esc(gel)}" target="_blank" rel="noopener"><img class="big" src="${esc(gel)}" alt="Lab digest"></a>` : '<div class="empty">No image</div>'}
          ${D.gelOriginal ? `<p class="tiny"><a href="${esc(D.gelOriginal)}" target="_blank" rel="noopener">Open the full-size original</a> (lab members only)</p>` : ""}</div>
        <div><div class="row"><b>Virtual digest</b>${stored && g ? `<button class="mini" data-act="togglevirtual">${showStored ? "Show predicted bands in lane order" : "Show the stored image"}</button>` : ""}</div>
          ${showStored ? `<img class="big" src="${esc(stored)}" alt="Virtual digest">` : g ? virtualGel() : '<div class="empty">No genome sequence yet, so no virtual digest. Results can still be recorded and compared later.</div>'}</div>
      </div>
      <h4>Result for each enzyme</h4>${lanesTable(true)}
      ${anyBlocked && D.control !== true ? '<div class="note bad">A lane is <b>blocked</b> (the genome has sites but the gel shows no cut). Blocked results are only counted when the control digested as expected: answer that below.</div>' : ""}
      <p class="row">Did the control digest as expected? <span class="seg">${[["true", "Yes"], ["false", "No"]].map((o) => `<button data-control="${o[0]}" class="${String(D.control) === o[0] ? "on" : ""}">${o[1]}</button>`).join("")}</span>
        ${D.controlPath ? `<a href="${esc(publicUrl(D.controlPath))}" target="_blank" rel="noopener">view the control gel</a>` : ""}</p>`;
  }
  function viewDigest() {
    const D = S.D, p = S.phage;
    const enz = D.lanes.filter((L) => !L.sp), unset = enz.filter((L) => !L.observed).length;
    const done = { plan: enz.length > 0, lab: !!(D.gelPath || D.legacyGelUrl || phageGel()), compare: enz.length > 0 && !unset && D.control != null };
    const tab = (k, label) => `<button class="tab ${S.step === k ? "on" : ""}" data-step="${k}">${done[k] ? "✓ " : ""}${label}</button>`;
    return `<p><a href="#/phage/${p.phage_id}">← ${esc(p.phage_name)}</a></p>
      <div class="card"><h2>${D.isNew ? "New digest" : "Digest"} · ${esc(p.phage_name)} <span class="sub">${esc(D.date || "")}</span></h2>
      <p class="sub">The three steps can be done in any order and saved at any point. Start with step 1 if you have the sequence, or step 2 if you ran the gel first.</p>
      <div class="tabs">${tab("plan", "1 Plan")}${tab("lab", "2 Lab")}${tab("compare", "3 Compare")}</div>
      <div class="step">${S.step === "plan" ? stepPlan() : S.step === "lab" ? stepLab() : stepCompare()}</div>
      <div class="savebar"><button class="primary" data-act="save"${S.busy ? " disabled" : ""}>Save</button>
        <span class="msg">${esc(S.busy || S.msg || (enz.length ? `${D.lanes.length} lane${D.lanes.length === 1 ? "" : "s"} · ${enz.length} enzyme${enz.length === 1 ? "" : "s"}${unset ? ` · ${unset} without a result` : ""}` : ""))}</span></div>
      </div>`;
  }

  // ---------- render and routing ----------
  let route = { name: "list" };
  function render() {
    const keep = document.activeElement && document.activeElement.id === "filter" ? document.activeElement.selectionStart : null;
    userBox.innerHTML = S.user ? `${esc(S.name || S.user.email || "")}${S.role ? ` · ${esc(S.role)}` : ""} <button id="signout">Sign out</button>` : "";
    if (!S.user) app.innerHTML = viewSignIn(S.msg);
    else if (!S.role || S.role === "viewer") app.innerHTML = viewNoAccess();
    else if (route.name === "digest" && S.D) app.innerHTML = viewDigest();
    else if (route.name === "phage" && S.phage) app.innerHTML = viewPhage();
    else app.innerHTML = viewList();
    if (keep != null) { const f = document.getElementById("filter"); if (f) { f.focus(); f.setSelectionRange(keep, keep); } }
  }
  async function go() {
    const h = location.hash.replace(/^#\/?/, "").split("/");
    try {
      if (!S.user || !S.role) { render(); return; }
      if (!S.catalog.length) await loadBase();
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
    const t = ev.target.closest("button, a.btn, tr[data-go]");
    if (!t) return;
    if (t.id === "signout") { await sb.auth.signOut(); S.user = null; S.role = null; S.catalog = []; S.phage = null; S.D = null; render(); return; }
    if (t.dataset.go) { location.hash = t.dataset.go; return; }
    const D = S.D;
    if (!D) return;
    if (t.dataset.step) { S.step = t.dataset.step; S.msg = ""; render(); return; }
    if (t.dataset.act === "save") { save(); return; }
    if (t.dataset.act === "order") { setOrder(document.getElementById("order").value); render(); return; }
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
    if (t.id === "need") { S.listNeed = t.checked; render(); return; }
    if (!D) return;
    if (t.dataset.pick) { toggleEnzyme(t.dataset.pick, t.checked); render(); return; }
    if (t.dataset.f) { D[t.dataset.f] = t.value; return; }
    if (t.dataset.upload && t.files[0]) { uploadImage(t.dataset.upload, t.files[0]); return; }
    if (t.dataset.controlfasta !== undefined && t.files[0]) {
      const f = DG.parseFasta(await t.files[0].text());
      if (f.seq.length < 100) { S.msg = "No DNA sequence was found in that file."; } else { S.control = { seq: f.seq, name: f.name || t.files[0].name }; D.controlName = S.control.name.slice(0, 80); }
      render();
    }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.id === "filter") { S.listFilter = ev.target.value; render(); }
    else if (ev.target.id === "order" && S.D) S.D.orderText = ev.target.value;
    else if (ev.target.dataset && ev.target.dataset.f && S.D) S.D[ev.target.dataset.f] = ev.target.value;
  });
  window.addEventListener("hashchange", go);

  (async function start() {
    app.innerHTML = '<p class="sub">Loading…</p>';
    await loadSession();
    go();
  })();
})();
