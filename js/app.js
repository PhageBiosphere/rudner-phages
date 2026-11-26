// Phage DNA Modification Analysis (Rudner Lab). First version: restriction digests (plan, lab, compare).
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
    ze: null,              // the enzyme whose notes an owner is editing: {id, sens, group, notes}
    pe: null,              // the preset being added or edited on the enzyme page: {id, name, lanes:[tokens]}
    ez: null, ezMsg: "",   // the add-enzyme form: last typed values and its message
    presets: [], presetDel: null,   // named lane lists shared by the lab; presetDel = the one an owner is about to delete
    catalog: [], enzymes: [], digestIndex: new Map(),   // phage_id -> [{experiment summary}]
    phage: null, digests: [], results: [],
    genome: null,          // {seq, label, source, circular, assembly_id, sha256} or {error}
    genes: null,           // {hits:[term], n}
    D: null, msg: "", busy: "", open: { enz: null, gel: null, ctl: null }, tab: "digest", guide: { on: true, y: 160 },
    sort: { k: "name", dir: 1 }, filters: { name: "", lab: "", host: "", species: "", strain: "", cluster: "", subcluster: "", genome: "", image: "", digest: "" }, pageSize: 25, page: 0,
    control: null,         // {seq, name}
    an: { loaded: false, raw: null, by: new Map(), checked: new Map(), queued: new Set(), sel: new Set(), qask: false, shownIds: [], show: "all", enz: "", q: "", min: "0", seq: "", host: "", chk: "", follow: false,
      sort: { k: "name", dir: 1 }, size: "25", page: 0, fig: "host", f1: { sort: { k: "n", dir: -1 }, f: {} }, f2: { sort: { k: "gc", dir: -1 }, f: {}, size: "10" }, f3: { sort: { k: "n", dir: -1 }, f: {}, size: "15" }, f4: { sort: { k: "ngenes", dir: -1 }, f: {}, size: "15" }, genes: [], isl: new Map(), msg: "", busy: false }   // the analysis page
  };

  const GEL_OPT = { numbers: true, names: true, scale: true, height: 300, run: 1, gap: 0, wells: 0 };
  const gelOpt = () => Object.assign({}, GEL_OPT, { ladder: S.D ? S.D.ladder : "" });   // the ladder is the one recorded for this digest
  const AN_KEYS = ["show", "enz", "q", "min", "seq", "host", "chk", "follow", "size", "fig"], okSort = (x) => x && typeof x.k === "string" && (x.dir === 1 || x.dir === -1);
  const anState = () => { const A = S.an, o = {}; for (const k of AN_KEYS) o[k] = A[k]; o.sort = A.sort; for (const f of ["f1", "f2", "f3", "f4"]) o[f] = { sort: A[f].sort, f: A[f].f, size: A[f].size }; return o; };
  function anApply(o) {
    if (!o || typeof o !== "object") return;
    const A = S.an;
    for (const k of AN_KEYS) if (k in o && typeof o[k] === typeof A[k]) A[k] = o[k];
    if (okSort(o.sort)) A.sort = { k: o.sort.k, dir: o.sort.dir };
    for (const f of ["f1", "f2", "f3", "f4"]) { const x = o[f]; if (!x || typeof x !== "object") continue; if (okSort(x.sort)) A[f].sort = { k: x.sort.k, dir: x.sort.dir }; if (x.f && typeof x.f === "object") A[f].f = Object.fromEntries(Object.entries(x.f).filter((e) => typeof e[1] === "string")); if (typeof x.size === "string" && A[f].size) A[f].size = x.size; }
    A.page = 0;
  }
  const AN_DEFAULT = JSON.stringify(anState());
  try { anApply(JSON.parse(localStorage.getItem("rudner.analysis") || "null")); } catch (err) { /* remembered filters are optional */ }
  try { Object.assign(GEL_OPT, JSON.parse(localStorage.getItem("rudner.gelopt") || "{}")); } catch (err) { /* remembered settings are optional */ }
  const saveGelOpt = () => { try { localStorage.setItem("rudner.gelopt", JSON.stringify(GEL_OPT)); } catch (err) { /* not remembered */ } };
  const gelOptBar = () => `<span class="gelopt">Labels: ${[["numbers", "lane numbers"], ["names", "enzyme names"], ["scale", "ladder sizes"]].map((o) => `<label class="check"><input type="checkbox" data-gelopt="${o[0]}"${GEL_OPT[o[0]] ? " checked" : ""}>${o[1]}</label>`).join("")}</span>`;
  // ---------- small helpers ----------
  const publicUrl = (path) => (path ? sb.storage.from(CFG.IMAGE_BUCKET).getPublicUrl(path).data.publicUrl : "");
  const enzyme = (id) => S.enzymes.find((z) => z.restriction_enzyme_id === id) || {};
  const laneName = (L) => (L.sp === "ladder" ? "Ladder" : L.sp === "uncut" ? "Uncut" : enzyme(L.id).enzyme_name || "?");
  const cutsOf = (id) => (S.genome && S.genome.seq ? DG.digest(S.genome.seq, enzyme(id).recognition_sequence, S.genome.circular) : null);
  const virtualCall = (id) => { const c = cutsOf(id); if (c) return c.sites > 0 ? "Digestion" : "No digestion"; const o = S.D && S.D.saved.get(id); return (o && o.virtual_digest_result) || ""; };
  // Blocked: the gel shows no cut, and the genome has sites. With no genome sequence a ✗ is presumed blocked.
  const virtOf = (r) => r.virtual_digest_result || (r.predicted_site_count > 0 ? "Digestion" : r.predicted_site_count === 0 ? "No digestion" : "");
  const isBlocked = (L) => !L.sp && L.observed === "No digestion" && virtualCall(L.id) !== "No digestion" && !(S.genome && S.genome.loading);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
  function stageOf(x, results) {
    const lanes = Array.isArray(x.lane_layout) ? x.lane_layout.filter((t) => t !== "L" && t !== "U") : [];
    const done = (results || []).filter((r) => r.restriction_digest_experiment_id === x.restriction_digest_experiment_id);
    const compared = lanes.length > 0 && lanes.every((id) => done.some((r) => r.restriction_enzyme_id === id)) && (x.positive_control_passed != null || x.no_control === true);
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
      sb.from("phage_catalog_public").select("phage_id,lab_phage_id,phage_name,host_genus,host_species,host_strain,phagesdb_cluster,phagesdb_subcluster,genome_length_bp,annotation_status,restriction_digest_image_url,virtual_digest_image_url").order("phage_name").range(0, 4999),
      sb.from("restriction_enzymes").select("*").eq("active", true).order("enzyme_name"),
      sb.from("restriction_digest_experiments").select("restriction_digest_experiment_id,phage_id,experiment_date,gel_image_path,gel_image_url,positive_control_passed,no_control,results_checked,lane_layout").range(0, 9999)
    ]);
    if (cat.error) throw cat.error;
    if (enz.error) throw enz.error;
    S.catalog = cat.data || []; S.enzymes = enz.data || [];
    S.digestIndex = new Map();
    for (const x of idx.data || []) { if (!S.digestIndex.has(x.phage_id)) S.digestIndex.set(x.phage_id, []); S.digestIndex.get(x.phage_id).push(x); }
    await loadPresets();
  }
  // Presets are a convenience: if they can't be read the rest of the site still works.
  async function loadPresets() {
    const r = await sb.from("restriction_enzyme_presets").select("restriction_enzyme_preset_id,preset_name,lane_layout").order("preset_name");
    S.presets = r.error ? [] : r.data || [];
  }
  async function loadPhage(id) {
    S.phage = S.catalog.find((p) => p.phage_id === id) || null;
    S.digests = []; S.results = []; S.genome = null; S.genes = null; S.pisl = null;
    if (!S.phage) return;
    sb.from("gene_browse_public").select("source,gene_key,phage_id,gene_number,start_bp,end_bp,strand,product").eq("phage_id", id).range(0, 999).then((g) => {   // optional, arrives a moment later
      if (!g.error && g.data && g.data.length && S.phage && S.phage.phage_id === id) { S.pisl = findIslands(g.data); if (route.name === "phage") render(); }
    }, () => {});
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
  // The lab's own genome files live in a private storage bucket, one per phage: <phage_id>.fasta
  const GENOME_BUCKET = "genome-fasta";
  async function genomeFiles() {
    if (!S.gfiles) { const r = await sb.storage.from(GENOME_BUCKET).list("", { limit: 1000 }); S.gfiles = new Set(r.error ? [] : (r.data || []).map((x) => x.name)); }
    return S.gfiles;
  }
  async function sha256hex(text) {
    try { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); } catch (err) { return null; }
  }
  async function uploadGenome(file) {
    S.busy = "Reading the genome file…"; render();
    try {
      const text = await file.text(), f = DG.parseFasta(text);
      if (!/^\s*>/.test(text) || f.seq.length < 1000) throw new Error("that file does not look like a genome FASTA (a line starting with >, then at least 1,000 bases).");
      const name = `${S.phage.phage_id}.fasta`;
      const up = await sb.storage.from(GENOME_BUCKET).upload(name, new Blob([text], { type: "text/plain" }), { contentType: "text/plain", upsert: true });
      if (up.error) throw up.error;
      (await genomeFiles()).add(name);
      S.genome = null; S.genes = null; S.busy = ""; S.msg = `Genome uploaded (${fmt(f.seq.length)} bp). The virtual digest now uses it.`;
      loadGenome();
    } catch (err) { S.busy = ""; S.msg = `Genome not uploaded: ${err.message || err}`; render(); }
  }
  async function fetchGenome(phageId) {
    const st = await sb.from("phage_workflow_status_public").select("selected_assembly_id,assembly_label,assembly_sha256,fasta_download_url,circularized").eq("phage_id", phageId).maybeSingle();
    const rec = st.data || {};
    let text = "", source = "", label = "";
    let up = false;
    const gname = `${phageId}.fasta`;
    if ((await genomeFiles()).has(gname)) {
      const d = await sb.storage.from(GENOME_BUCKET).download(gname);
      if (!d.error && d.data) { text = await d.data.text(); source = `Rudner Lab upload (${GENOME_BUCKET}/${gname})`; label = "Genome uploaded by the lab"; up = true; }
    }
    let labErr = "";
    if (!text && rec.fasta_download_url) {
      try {
        const r = await fetch(rec.fasta_download_url);
        if (!r.ok) throw new Error(`status ${r.status}`);
        text = await r.text(); source = rec.fasta_download_url; label = rec.assembly_label || "Rudner Lab assembly";
        if (!/^\s*>/.test(text)) { text = ""; throw new Error("the address returned a web page, not a FASTA file"); }
      } catch (err) { labErr = `The lab's genome file could not be read from where it is stored (${err.message || err}); a browser can only read it from an address that allows direct downloads.`; }
    }
    if (!text) {
      const px = await sb.functions.invoke("fetch-phage-fasta", { body: { phage_id: phageId } });
      if (px.error || !px.data || !px.data.fasta) throw new Error(labErr || (px.data && px.data.error) || "No genome sequence is available for this phage yet.");
      text = px.data.fasta; source = px.data.source_url || "PhagesDB"; label = "PhagesDB FASTA";
    }
    const f = DG.parseFasta(text);
    if (!f.seq.length) throw new Error("The genome file holds no DNA sequence.");
    const lab = source === rec.fasta_download_url;   // the assembly's id and checksum only describe the lab's own file
    return { seq: f.seq, label, source, circular: !!rec.circularized, assembly_id: lab ? rec.selected_assembly_id || null : null, sha256: up ? await sha256hex(text) : lab ? rec.assembly_sha256 || null : null };
  }
  async function loadGenome() {
    if (S.genome || !S.phage) return;
    S.genome = { loading: true }; render();
    try {
      S.genome = await fetchGenome(S.phage.phage_id);
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
  // What would be saved, as text: comparing it with the copy taken when the digest was opened shows unsaved changes.
  const snapOf = (D) => JSON.stringify([D.date, D.ladder, D.control, D.controlName, D.gelPath, D.controlPath, D.virtualPath, D.gelOriginal, D.controlOriginal, !!D.checked, D.lanes.map((L) => [L.sp || L.id, L.observed || ""]), Object.keys(D.controlCalls).sort().map((k) => [k, D.controlCalls[k]])]);
  const isDirty = () => !!(S.D && S.D.snap && snapOf(S.D) !== S.D.snap);
  function openDigest(expId) {
    const x = expId === "new" ? null : S.digests.find((d) => d.restriction_digest_experiment_id === expId);
    const D = {
      id: x ? x.restriction_digest_experiment_id : uuid(), isNew: !x,
      date: (x && x.experiment_date) || "", ladder: (x && x.ladder) || "",
      control: x ? (x.no_control ? "none" : x.positive_control_passed) : null,   // true, false, "none" (no control was run) or null (not answered)
      controlName: (x && x.control_name) || "Lambda DNA",
      checked: !!(x && x.results_checked), checkedAt: (x && x.results_checked_at) || null,   // results checked against the gel
      gelPath: (x && x.gel_image_path) || "", controlPath: (x && x.control_image_path) || "", virtualPath: (x && x.virtual_image_path) || "",
      gelOriginal: (x && x.gel_original_url) || "", controlOriginal: (x && x.control_original_url) || "",
      legacyGelUrl: (x && x.gel_image_url) || "", lanes: [], saved: new Map(), controlCalls: Object.assign({}, (x && x.control_results) || {}), orderText: "", orderMsg: "", showStoredVirtual: false
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
    D.delAsk = false; D.snap = snapOf(D);
    S.cur = D.lanes.findIndex((L) => !L.sp && !L.observed); if (S.cur < 0) S.cur = D.lanes.findIndex((L) => !L.sp);
    if (S.zoomFor !== D.id) { S.zoom = { k: 1, x: 0, y: 0 }; S.zoomFor = D.id; }
    S.D = D; S.msg = "";
    S.open = { enz: null, gel: null, ctl: null }; S.tab = "digest";
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
  // ---------- enzyme presets: named lane lists (for example High GC, Low GC) shared by the lab ----------
  const layoutOf = (lanes) => lanes.map((L) => (L.sp === "ladder" ? "L" : L.sp === "uncut" ? "U" : L.id));
  const presetLabel = (P) => (Array.isArray(P.lane_layout) ? P.lane_layout : []).map((t) => (t === "L" ? "Ladder" : t === "U" ? "Uncut" : enzyme(t).enzyme_name || "(enzyme no longer listed)")).join(", ");
  function applyPreset(id) {
    const D = S.D, P = S.presets.find((x) => x.restriction_enzyme_preset_id === id);
    if (!P) return;
    const old = D.lanes, next = [];
    for (const t of Array.isArray(P.lane_layout) ? P.lane_layout : []) {
      if (t === "L") next.push({ sp: "ladder" }); else if (t === "U") next.push({ sp: "uncut" });
      else if (S.enzymes.some((z) => z.restriction_enzyme_id === t) && !next.some((L) => L.id === t)) next.push(old.find((L) => L.id === t) || { id: t, observed: "" });
    }
    // A preset never drops an enzyme that already has a result (saved or just entered): it is kept at the end.
    const kept = old.filter((L) => !L.sp && !next.some((n) => n.id === L.id) && (L.observed || D.saved.has(L.id) || D.controlCalls[L.id]));
    D.lanes = next.concat(kept);
    S.msg = `Preset "${P.preset_name}" applied.${kept.length ? ` ${kept.map(laneName).join(", ")} kept at the end because ${kept.length === 1 ? "it has" : "they have"} a result.` : ""} Save to keep it with this digest.`;
  }
  async function savePreset(name) {
    const D = S.D; name = String(name || "").trim().slice(0, 60);
    if (!name) { S.msg = "Type a name for the preset first, for example High GC."; render(); return; }
    if (!D.lanes.some((L) => !L.sp)) { S.msg = "Choose at least one enzyme before saving a preset."; render(); return; }
    const same = S.presets.find((x) => x.preset_name.trim().toLowerCase() === name.toLowerCase());
    S.busy = "Saving the preset…"; render();
    const r = same
      ? await sb.from("restriction_enzyme_presets").update({ lane_layout: layoutOf(D.lanes) }).eq("restriction_enzyme_preset_id", same.restriction_enzyme_preset_id)
      : await sb.from("restriction_enzyme_presets").insert({ preset_name: name, lane_layout: layoutOf(D.lanes) });
    if (r.error) S.msg = `Preset not saved: ${r.error.message || r.error}`;
    else { await loadPresets(); D.presetName = ""; S.msg = same ? `Preset "${same.preset_name}" now holds these lanes.` : `Preset "${name}" saved. It can be chosen on every phage's digest page.`; }
    S.busy = ""; render();
  }
  async function deletePreset(id) {
    const r = await sb.from("restriction_enzyme_presets").delete().eq("restriction_enzyme_preset_id", id);
    S.presetDel = null;
    if (r.error) S.msg = `Preset not deleted: ${r.error.message || r.error}`; else { await loadPresets(); S.msg = "Preset deleted. Digests that used it are unchanged."; }
  }
  // ---------- images ----------
  // A PDF gel: its first page is drawn as an image here in the browser. The PDF reader (pdf.js) is only loaded when a PDF is chosen.
  const isPdf = (file) => /\.pdf$/i.test(file.name || "") || file.type === "application/pdf";
  let pdfLib = null;
  function loadPdfLib() {
    if (!pdfLib) pdfLib = new Promise((resolve, reject) => {
      const s = document.createElement("script"); s.src = "js/vendor/pdf.min.js";
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "js/vendor/pdf.worker.min.js"; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfLib = null; reject(new Error("The PDF reader could not be loaded.")); };
      document.head.appendChild(s);
    });
    return pdfLib;
  }
  async function pdfToImage(file) {
    const lib = await loadPdfLib();
    let doc;
    try { doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; } catch (err) { throw new Error("That PDF could not be read. If it is password-protected, export the gel as an image instead."); }
    const page = await doc.getPage(1), v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: Math.min(6, CFG.IMAGE_MAX_SIDE / Math.max(v1.width, v1.height)) });
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", CFG.IMAGE_QUALITY));
    if (!blob) throw new Error("The PDF page could not be converted to an image.");
    return { blob, w: c.width, h: c.height, pages: doc.numPages };
  }
  const pdfNote = (r) => (r.pages ? (r.pages > 1 ? ` Page 1 of the PDF's ${r.pages} pages was used.` : " The PDF page was turned into an image.") : "");
  function resizeImage(file) {
    if (isPdf(file)) return pdfToImage(file);
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
      S.msg = `Image uploaded (${r.w} × ${r.h}, ${Math.round(r.blob.size / 1024)} KB).${pdfNote(r)} Save to keep it with this digest.`;
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
    let ok = false;
    try {
      const row = {
        experiment_date: D.date || null, ladder: D.ladder || null, positive_control_passed: D.control === "none" ? null : D.control, no_control: D.control === "none", control_name: D.controlName || null,
        results_checked: !!D.checked, results_checked_at: D.checked ? D.checkedAt || new Date().toISOString() : null,
        gel_image_path: D.gelPath || null, control_image_path: D.controlPath || null, virtual_image_path: D.virtualPath || null,
        gel_original_url: D.gelOriginal.trim() || null, control_original_url: D.controlOriginal.trim() || null,
        lane_layout: D.lanes.map((L) => (L.sp === "ladder" ? "L" : L.sp === "uncut" ? "U" : L.id)),
        control_results: Object.fromEntries(D.lanes.filter((L) => !L.sp && D.controlCalls[L.id]).map((L) => [L.id, D.controlCalls[L.id]]))
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
      const keepOpen = S.open, keepTab = S.tab, id = D.id, keepGenome = S.genome, keepGenes = S.genes;
      await loadBase(); await loadPhage(S.phage.phage_id);
      S.genome = keepGenome; S.genes = keepGenes;
      openDigest(id); S.open = keepOpen; S.tab = keepTab;
      const unset = S.D.lanes.filter((L) => !L.sp && !L.observed).length;
      S.msg = unset ? `Saved. ${unset} enzyme${unset === 1 ? "" : "s"} still without a result; come back to finish.` : "Saved.";
      ok = true;
    } catch (err) { S.msg = `Not saved: ${err.message || err}`; }
    S.busy = ""; render();
    return ok;
  }
  // Review mode: tick "checked", save, and open the next digest that still needs checking (phages in name order).
  async function saveAndNext() {
    const cur = S.phage.phage_id, curId = S.D.id;
    S.D.checked = true;
    if (!(await save())) return;
    const start = Math.max(0, S.catalog.findIndex((p) => p.phage_id === cur));
    for (let k = 0; k < S.catalog.length; k++) {
      const p = S.catalog[(start + k) % S.catalog.length];
      const x = (S.digestIndex.get(p.phage_id) || []).find((d) => !d.results_checked && d.restriction_digest_experiment_id !== curId);
      if (x) { location.hash = `#/phage/${p.phage_id}/digest/${x.restriction_digest_experiment_id}`; return; }
    }
    S.msg = "Saved. Every digest has now been checked."; render();
  }
  async function deleteDigest() {
    const D = S.D, pid = S.phage.phage_id;
    S.busy = "Deleting…"; render();
    try {
      const r1 = await sb.from("restriction_digest_results").delete().eq("restriction_digest_experiment_id", D.id);
      if (r1.error) throw r1.error;
      const r2 = await sb.from("restriction_digest_experiments").delete().eq("restriction_digest_experiment_id", D.id);
      if (r2.error) throw r2.error;
      const paths = [D.gelPath, D.controlPath, D.virtualPath].filter(Boolean);
      if (paths.length) await sb.storage.from(CFG.IMAGE_BUCKET).remove(paths);   // its uploaded images go too
      S.D = null; S.busy = ""; await loadBase(); await loadPhage(pid);
      location.hash = `#/phage/${pid}`;
    } catch (err) { S.busy = ""; D.delAsk = false; S.msg = `Not deleted: ${err.message || err}`; render(); }
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
  const labId = (p) => String(p.lab_phage_id || "").replace(/^RUD-/i, "");
  const LIST_COLS = [["name", "Phage", (p) => p.phage_name], ["lab", "Rud Lab ID", labId], ["host", "Genus", (p) => p.host_genus], ["species", "Species", (p) => p.host_species], ["strain", "Strain", (p) => p.host_strain], ["cluster", "Cluster", (p) => p.phagesdb_cluster], ["subcluster", "Subcluster", (p) => p.phagesdb_subcluster]];
  // A phage has a digest image when its record carries one (usually from PhagesDB) or one of its digests has an uploaded gel.
  const hasGelImage = (p) => !!p.restriction_digest_image_url || (S.digestIndex.get(p.phage_id) || []).some((x) => x.gel_image_path || x.gel_image_url);
  function listRows() {
    const F = S.filters, has = (v, f) => !f || String(v || "").toLowerCase().includes(f.trim().toLowerCase());
    const dn = (p) => (S.digestIndex.get(p.phage_id) || []).length, toCheck = (p) => (S.digestIndex.get(p.phage_id) || []).filter((x) => !x.results_checked).length;
    let rows = S.catalog.filter((p) => LIST_COLS.every((c) => has(c[2](p), F[c[0]]) || (c[0] === "lab" && has(p.lab_phage_id, F.lab)))
      && (!F.genome || (F.genome === "yes") === !!p.genome_length_bp) && (!F.image || (F.image === "yes") === hasGelImage(p))
      && (!F.digest || (F.digest === "yes" ? dn(p) > 0 : F.digest === "no" ? dn(p) === 0 : F.digest === "tocheck" ? toCheck(p) > 0 : dn(p) > 0 && toCheck(p) === 0)));
    const col = LIST_COLS.find((c) => c[0] === S.sort.k);
    const key = col ? (p) => String(col[2](p) || "").toLowerCase() : S.sort.k === "genome" ? (p) => p.genome_length_bp || 0 : S.sort.k === "image" ? (p) => (hasGelImage(p) ? 1 : 0) : dn;
    rows = rows.slice().sort((a, b) => { const x = key(a), y = key(b); if (x === "" && y !== "") return 1; if (y === "" && x !== "") return -1; return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir || (a.phage_name || "").localeCompare(b.phage_name || ""); });
    return rows;
  }
  function viewList() {
    const rows = listRows(), F = S.filters, n = S.pageSize, pages = Math.max(1, Math.ceil(rows.length / n));
    S.page = Math.min(S.page, pages - 1);
    const shown = rows.slice(S.page * n, S.page * n + n);
    const th = (k, label) => `<th data-sort="${k}" title="Sort by this column">${label} <span class="arrow">${S.sort.k === k ? (S.sort.dir > 0 ? "▲" : "▼") : ""}</span></th>`;
    const tf = (k) => `<td><input data-lf="${k}" value="${esc(F[k] || "")}" placeholder="filter"></td>`;
    const sf = (k, yes, no) => `<td><select data-lf="${k}"><option value="">all</option><option value="yes"${F[k] === "yes" ? " selected" : ""}>${yes}</option><option value="no"${F[k] === "no" ? " selected" : ""}>${no}</option></select></td>`;
    const pager = `<div class="row pager"><label class="check">Rows <select id="pagesize">${[15, 25, 50, 100].map((v) => `<option${v === n ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      <button data-page="-1"${S.page ? "" : " disabled"}>◀ Previous</button><span class="sub">Page ${S.page + 1} of ${pages} · ${fmt(rows.length)} of ${fmt(S.catalog.length)} phages</span><button data-page="1"${S.page < pages - 1 ? "" : " disabled"}>Next ▶</button>
      ${Object.values(F).some(Boolean) ? '<button data-act="clearfilters">Clear filters</button>' : ""}</div>`;
    return `<div class="card"><h2>Phages</h2>${pager}
      <div class="tablescroll"><table class="list sortable"><thead><tr>${LIST_COLS.map((c) => th(c[0], c[1])).join("")}${th("genome", "Genome")}${th("image", "Digest image")}${th("digest", "Restriction digests")}</tr>
      <tr class="filters">${LIST_COLS.map((c) => tf(c[0])).join("")}${sf("genome", "has a sequence", "no sequence")}${sf("image", "has an image", "no image")}<td><select data-lf="digest">${[["", "all"], ["tocheck", "need checking"], ["checked", "all checked"], ["yes", "has a digest"], ["no", "none yet"]].map((o) => `<option value="${o[0]}"${F.digest === o[0] ? " selected" : ""}>${o[1]}</option>`).join("")}</select></td></tr></thead><tbody>
      ${shown.map((p) => { const d = S.digestIndex.get(p.phage_id) || []; return `<tr data-go="#/phage/${p.phage_id}">${LIST_COLS.map((c, i) => `<td>${i ? esc(c[2](p) || "") : `<b>${esc(c[2](p) || "")}</b>`}</td>`).join("")}<td>${p.genome_length_bp ? fmt(p.genome_length_bp) + " bp" : '<span class="sub">no sequence</span>'}</td><td>${hasGelImage(p) ? chip("image", "ok") : chip("no image", "warn")}</td><td>${d.length ? chip(`${d.length} digest${d.length === 1 ? "" : "s"}`, "ok") + (d.some((x) => !x.results_checked) ? " " + chip(d.length === 1 ? "to check" : `${d.filter((x) => !x.results_checked).length} to check`, "warn") : " " + chip("checked", "ok")) : chip("none", "mute")}</td></tr>`; }).join("") || `<tr><td colspan="${LIST_COLS.length + 3}" class="sub">No phage matches these filters.</td></tr>`}
      </tbody></table></div>${pager}</div>`;
  }
  // ---------- the enzyme page: preset lists, the enzyme catalogue, and (owners) adding an enzyme ----------
  const tokName = (t) => (t === "L" ? "Ladder" : t === "U" ? "Uncut" : enzyme(t).enzyme_name || "(enzyme no longer listed)");
  function presetEditor() {
    const E = S.pe, last = E.lanes.length - 1;
    const box = (tok, label) => { const on = E.lanes.includes(tok); return `<label class="pick${on ? " on" : ""}"><input type="checkbox" data-petoggle="${tok}"${on ? " checked" : ""}><span>${label}</span></label>`; };
    return `<div class="pe"><label class="check"><b>Preset name</b> <input type="text" data-pename maxlength="60" value="${esc(E.name)}" placeholder="for example Low GC phages"></label>
      ${E.lanes.length ? `<div class="order"><span class="sub">Lane order:</span>${E.lanes.map((t, i) => `<span class="ord${t === "L" || t === "U" ? " sp" : ""}"><button class="mini" data-pemove="${i}" data-dir="-1"${i ? "" : " disabled"} title="Move one lane to the left">◀</button><b>${esc(tokName(t))}</b><button class="mini" data-pemove="${i}" data-dir="1"${i < last ? "" : " disabled"} title="Move one lane to the right">▶</button></span>`).join("")}<button class="mini" data-pe="addladder" title="Add another ladder lane at the end">+ ladder</button></div>` : ""}
      <div class="picks">${box("L", "<b>Ladder</b>")}${box("U", "<b>Uncut</b>")}${S.enzymes.map((z) => box(z.restriction_enzyme_id, `<b>${esc(z.enzyme_name)}</b> <span class="mono">${esc(cutSite(z))}</span>`)).join("")}</div>
      <p class="tiny">Tick the lanes on the gel; a newly ticked enzyme goes to the end, and the arrows change the order.</p>
      <div class="row"><button class="primary" data-pe="save">Save preset</button><button data-pe="cancel">Cancel</button><span class="msg">${esc(S.msg)}</span></div></div>`;
  }
  async function savePresetEdit() {
    const E = S.pe, name = E.name.trim().slice(0, 60);
    if (!name) { S.msg = "Give the preset a name."; render(); return; }
    if (!E.lanes.some((t) => t !== "L" && t !== "U")) { S.msg = "Tick at least one enzyme."; render(); return; }
    const clash = S.presets.find((x) => x.restriction_enzyme_preset_id !== E.id && x.preset_name.trim().toLowerCase() === name.toLowerCase());
    if (clash) { S.msg = `There is already a preset called "${clash.preset_name}". Choose another name.`; render(); return; }
    const r = E.id
      ? await sb.from("restriction_enzyme_presets").update({ preset_name: name, lane_layout: E.lanes }).eq("restriction_enzyme_preset_id", E.id)
      : await sb.from("restriction_enzyme_presets").insert({ preset_name: name, lane_layout: E.lanes });
    if (r.error) S.msg = `Preset not saved: ${r.error.message || r.error}`;
    else { await loadPresets(); S.pe = null; S.msg = `Preset "${name}" saved.`; }
    render();
  }
  const ENZ_FIELDS = [["enzyme_name", "Name", "EcoRI", true], ["recognition_sequence", "Recognition sequence", "GAATTC", true], ["cut_description", "Cut site (optional)", "G^AATTC"], ["modification_sensitivity", "Sensitivity to DNA modification (optional)", ""], ["diagnostic_group", "Diagnostic group (optional)", ""], ["notes", "Notes (optional)", ""]];
  async function addEnzyme(v) {
    S.ez = v;
    const fail = (m) => { S.ezMsg = m; render(); };
    const name = v.enzyme_name.trim(), seq = v.recognition_sequence.toUpperCase().replace(/\s+/g, ""), cut = v.cut_description.toUpperCase().replace(/\s+/g, "");
    if (!name) return fail("Type the enzyme's name.");
    if (!/^[ACGTRYSWKMBDHVN]{4,20}$/.test(seq)) return fail("The recognition sequence should be 4 or more DNA letters with no spaces: A, C, G, T, or the codes R Y S W K M B D H V N.");
    if (cut && ((cut.match(/[\^/]/g) || []).length !== 1 || cut.replace(/[\^/]/g, "") !== seq)) return fail("The cut site should be the recognition sequence with one ^ where the enzyme cuts, for example G^AATTC. It can be left empty.");
    const dup = await sb.from("restriction_enzymes").select("restriction_enzyme_id,enzyme_name,active").ilike("enzyme_name", name);
    if (dup.error) return fail(`Not added: ${dup.error.message || dup.error}`);
    const old = (dup.data || [])[0];
    if (old && old.active) return fail(`${old.enzyme_name} is already in the list.`);
    const row = { recognition_sequence: seq, cut_description: cut || null, modification_sensitivity: v.modification_sensitivity.trim() || null, diagnostic_group: v.diagnostic_group.trim() || null, notes: v.notes.trim() || null, active: true };
    const r = old
      ? await sb.from("restriction_enzymes").update(row).eq("restriction_enzyme_id", old.restriction_enzyme_id)
      : await sb.from("restriction_enzymes").insert({ enzyme_name: name, ...row });
    if (r.error) return fail(`Not added: ${r.error.message || r.error}`);
    const enz = await sb.from("restriction_enzymes").select("*").eq("active", true).order("enzyme_name");
    if (!enz.error) S.enzymes = enz.data || [];
    S.ez = null;
    S.ezMsg = old ? `${old.enzyme_name} was already in the catalogue but switched off. It is active again, with the details typed here.` : `${name} added. It can now be chosen on every digest and in every preset.`;
    render();
  }
  function viewEnzymes() {
    const owner = S.role === "owner", E = S.pe, Z = S.ez || {};
    const prow = (P) => {
      const id = P.restriction_enzyme_preset_id;
      if (E && E.id === id) return `<tr><td colspan="3">${presetEditor()}</td></tr>`;
      return `<tr><td><b>${esc(P.preset_name)}</b></td><td>${esc(presetLabel(P))}</td><td class="acts"><button class="mini" data-pe="edit" data-id="${id}">Edit</button>${owner ? (S.presetDel === id ? ` <span class="sub">Delete?</span> <button class="mini" data-presetdel="${id}" data-yes="1">Yes</button> <button class="mini" data-presetdel="">No</button>` : ` <button class="mini" data-presetdel="${id}">Delete</button>`) : ""}</td></tr>`;
    };
    return `<p><a href="#/">← All phages</a></p>
      <div class="card"><h2>Preset lists <span class="sub">lanes in gel order, chosen with one click on a digest</span></h2>
      ${S.presets.length ? `<table class="list"><thead><tr><th>Preset</th><th>Lanes, in order</th><th></th></tr></thead><tbody>${S.presets.map(prow).join("")}</tbody></table>` : '<p class="sub">No presets saved yet.</p>'}
      ${E && !E.id ? `<h4>New preset</h4>${presetEditor()}` : E ? "" : `<div class="row"><button class="primary" data-pe="new">+ New preset</button><span class="msg">${esc(S.msg)}</span></div>`}
      <p class="tiny">Changing or deleting a preset does not change digests that were already saved with it.${owner ? "" : " Only an owner can delete a preset."}</p></div>
      <div class="card"><h2>Enzyme details</h2>
      <p class="sub">The restriction enzymes in the lab's catalogue. This page is the same for every phage; the number of cuts and the predicted fragments depend on the genome and are shown on each digest.</p>
      <table class="list"><thead><tr><th>Enzyme</th><th>Recognition sequence</th><th>Cut</th><th>Site group</th><th>Sensitivity to DNA modification</th><th>Diagnostic group</th><th>Notes</th>${owner ? "<th></th>" : ""}</tr></thead><tbody>
      ${S.enzymes.map((z) => {
        const ed = S.ze && S.ze.id === z.restriction_enzyme_id, inp = (k, ph) => `<input data-zef="${k}" value="${esc(S.ze[k] || "")}" placeholder="${ph}" maxlength="300">`;
        return `<tr><td><b>${esc(z.enzyme_name)}</b></td><td class="mono">${esc(z.recognition_sequence)}</td><td class="mono">${esc(cutSite(z))}</td><td>${esc((SITE_GROUPS.find((g) => g[0] === siteGroup(z)) || [])[1] || "")}</td><td>${ed ? inp("sens", "for example: blocked by 5-methylcytosine") : esc(z.modification_sensitivity || "")}</td><td>${ed ? inp("group", "optional") : esc(z.diagnostic_group || "")}</td><td class="tiny">${ed ? inp("notes", "optional") : esc(z.notes || "")}</td>${owner ? `<td class="acts">${ed ? '<button class="mini primary" data-ze="save">Save</button> <button class="mini" data-ze="cancel">Cancel</button>' : `<button class="mini" data-ze="edit" data-id="${z.restriction_enzyme_id}">Edit</button>`}</td>` : ""}</tr>`;
      }).join("")}
      </tbody></table>
      ${owner ? `<form id="enzadd" class="enzadd"><h4>Add a restriction enzyme</h4><div class="grid">${ENZ_FIELDS.map((f) => `<label>${f[1]}<input name="${f[0]}" maxlength="${f[0] === "notes" || f[0] === "modification_sensitivity" ? 300 : 60}" value="${esc(Z[f[0]] || "")}" placeholder="${f[2]}"${f[3] ? " required" : ""}></label>`).join("")}</div>
        <div class="row"><button class="primary">Add enzyme</button><span class="msg">${esc(S.ezMsg)}</span></div></form>` : '<p class="tiny">Only a lab owner can add an enzyme to the catalogue.</p>'}
      </div>`;
  }
  // ---------- analysis: every phage with recorded results, one column per enzyme ----------
  // The server returns at most 1,000 rows at a time, so a whole table is read page by page.
  async function fetchAll(table, cols, key) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const r = await sb.from(table).select(cols).order(key).range(from, from + 999);
      if (r.error) throw r.error;
      out.push(...(r.data || []));
      if (!r.data || r.data.length < 1000) return out;
    }
  }
  // Enzymes are grouped by what their recognition site is made of: only G and C, only A and T, or both.
  const siteGroup = (z) => { const s = String(z.recognition_sequence || "").toUpperCase(); return !s ? "both" : /^[GCS]+$/.test(s) ? "gc" : /^[ATW]+$/.test(s) ? "at" : "both"; };
  const SITE_GROUPS = [["gc", "G/C sites only"], ["at", "A/T sites only"], ["both", "G/C and A/T in the site"]];
  const hostOf = (p) => [p.host_genus, p.host_species, p.host_strain].filter(Boolean).join(" ");
  const setPath = (o, path, v) => { const ks = path.split("."), last = ks.pop(); for (const k of ks) o = o[k] || (o[k] = {}); o[last] = v; };
  const getPath = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  async function loadAnalysis() {
    const [ex, rs] = await Promise.all([
      fetchAll("restriction_digest_experiments", "restriction_digest_experiment_id,phage_id,experiment_date,positive_control_passed,no_control,results_checked", "restriction_digest_experiment_id"),
      fetchAll("restriction_digest_results", "restriction_digest_result_id,restriction_digest_experiment_id,restriction_enzyme_id,observed_result,virtual_digest_result,predicted_site_count", "restriction_digest_result_id")
    ]);
    S.an.raw = { ex, rs };
    const qr = await sb.from("sequencing_requests").select("phage_id,status").in("status", ["requested", "queued"]);   // optional: who is already waiting to be sequenced
    S.an.queued = new Set(qr.error ? [] : (qr.data || []).map((x) => x.phage_id));
    // optional: the annotated genes, for the modification-island search
    try { S.an.genes = await fetchAll("gene_browse_public", "source,gene_key,phage_id,gene_number,start_bp,end_bp,strand,product", "gene_key"); } catch (err) { S.an.genes = []; }
    buildIslands();
    buildAnalysis(); S.an.loaded = true;
  }
  // The latest result for each enzyme of each phage: phage_id -> Map(enzyme_id -> cell). `keep` can leave digests out.
  function latestByPhage(ex, rs, keep) {
    const exp = new Map(ex.map((x) => [x.restriction_digest_experiment_id, x])), by = new Map();
    for (const r of rs) {
      const x = exp.get(r.restriction_digest_experiment_id);
      if (!x || !r.observed_result || (keep && !keep(x))) continue;
      const virt = virtOf(r);
      const cell = { obs: r.observed_result, virt, date: x.experiment_date || "", ctl: x.positive_control_passed === true, noctl: x.no_control === true, blocked: r.observed_result === "No digestion" && virt !== "No digestion", n: 1, mixed: false };
      if (!by.has(x.phage_id)) by.set(x.phage_id, new Map());
      const m = by.get(x.phage_id), old = m.get(r.restriction_enzyme_id);
      if (old) { const keepCell = cell.date > old.date ? cell : old, mixed = old.mixed || old.obs !== cell.obs, n = old.n + 1; keepCell.mixed = mixed; keepCell.n = n; m.set(r.restriction_enzyme_id, keepCell); }
      else m.set(r.restriction_enzyme_id, cell);
    }
    return by;
  }
  function buildAnalysis() {
    const A = S.an, chk = new Map();
    for (const x of A.raw.ex) { const c = chk.get(x.phage_id) || { n: 0, c: 0 }; c.n += 1; if (x.results_checked) c.c += 1; chk.set(x.phage_id, c); }
    A.by = latestByPhage(A.raw.ex, A.raw.rs, A.chk === "yes" ? (x) => x.results_checked : A.chk === "no" ? (x) => !x.results_checked : null); A.checked = chk;
  }
  // The enzymes that have results, grouped by site (G/C only, A/T only, both) and then by name.
  const usedEnzymes = (maps) => { const order = { gc: 0, at: 1, both: 2 }; return S.enzymes.filter((z) => maps.some((m) => m.has(z.restriction_enzyme_id))).map((z) => Object.assign({ grp: siteGroup(z) }, z)).sort((x, y) => order[x.grp] - order[y.grp] || x.enzyme_name.localeCompare(y.enzyme_name)); };
  // One phage's results summed up: blocked enzymes, counts per site group, the likely modification and how strong the evidence is.
  function phageRow(p, m, used, chk) {
    const r = { p, m, name: p.phage_name || "", host: hostOf(p), cluster: p.phagesdb_subcluster || p.phagesdb_cluster || "", blk: [], sure: [], tested: 0, gc: { b: 0, n: 0 }, at: { b: 0, n: 0 }, both: { b: 0, n: 0 }, chk: chk || { n: 0, c: 0 } };
    for (const z of used) { const c = m.get(z.restriction_enzyme_id); if (!c) continue; r.tested += 1; r[z.grp].n += 1; if (c.blocked) { r.blk.push(z); r[z.grp].b += 1; if (c.ctl && c.virt) r.sure.push(z); } }
    // The call: G/C when at least two G/C-site enzymes, and at least half of those tested, are blocked; A/T when at least half of the A/T-site enzymes tested are blocked.
    const gHit = r.gc.b >= 2 && r.gc.b / r.gc.n >= 0.5, aHit = r.at.b >= 1 && r.at.b / r.at.n >= 0.5, seqd = !!p.genome_length_bp;
    r.call = gHit && aHit ? "G/C and A/T" : gHit ? "G/C" : aHit ? "A/T" : !r.gc.b && !r.at.b ? (r.gc.n + r.at.n ? "None seen" : "Not tested") : "Unclear";
    r.ev = !gHit && !aHit ? "" : seqd && r.blk.every((z) => m.get(z.restriction_enzyme_id).virt) ? "Genome-checked" : aHit && !seqd ? "Weak: A/T sites unconfirmed" : "Lab gel only";
    return r;
  }
  // Fills in the virtual digest for every recorded result of every phage that has a genome sequence.
  async function recomputeVirtual() {
    const A = S.an, todo = S.catalog.filter((p) => p.genome_length_bp && A.by.has(p.phage_id)), failed = [];
    let done = 0, changed = 0;
    A.busy = true;
    for (const p of todo) {
      A.msg = `Virtual digests: phage ${done + failed.length + 1} of ${todo.length} (${p.phage_name})…`; render();
      try {
        const g = await fetchGenome(p.phage_id);
        const ex = await sb.from("restriction_digest_experiments").select("restriction_digest_experiment_id").eq("phage_id", p.phage_id);
        if (ex.error) throw ex.error;
        const ids = (ex.data || []).map((x) => x.restriction_digest_experiment_id);
        const rs = ids.length ? await sb.from("restriction_digest_results").select("restriction_digest_result_id,restriction_enzyme_id").in("restriction_digest_experiment_id", ids) : { data: [] };
        if (rs.error) throw rs.error;
        const jobs = (rs.data || []).map((r) => {
          const z = enzyme(r.restriction_enzyme_id);
          if (!z.recognition_sequence) return null;
          const c = DG.digest(g.seq, z.recognition_sequence, g.circular);
          return sb.from("restriction_digest_results").update({ virtual_digest_result: c.sites > 0 ? "Digestion" : "No digestion", predicted_site_count: c.sites, predicted_fragment_sizes_bp: c.fragments, predicted_sequence_source: g.source, predicted_assembly_id: g.assembly_id, predicted_sequence_sha256: g.sha256 }).eq("restriction_digest_result_id", r.restriction_digest_result_id);
        }).filter(Boolean);
        const bad = (await Promise.all(jobs)).find((r) => r.error);
        if (bad) throw bad.error;
        changed += jobs.length; done += 1;
      } catch (err) { failed.push(`${p.phage_name} (${err.message || err})`); }
    }
    try { await loadAnalysis(); } catch (err) { failed.push(`reading the results again (${err.message || err})`); }
    A.busy = false;
    A.msg = `Virtual digests filled in for ${done} phage${done === 1 ? "" : "s"} (${fmt(changed)} enzyme results in total).${failed.length ? ` Not done for ${failed.length}: ${failed.slice(0, 4).join("; ")}${failed.length > 4 ? " …" : ""}` : ""}`;
    render();
  }
  // Adds the ticked phages to the lab's sequencing queue (the same queue as on the phage database page).
  async function queueSelected() {
    const A = S.an, ids = [...A.sel];
    A.qask = false; A.busy = true; A.msg = "Adding to the sequencing queue…"; render();
    const r = await sb.rpc("queue_sequencing", { p_phage_ids: ids, p_reason: "first_sequencing", p_notes: "Flagged on the Phage DNA Modification Analysis page: blocked restriction enzymes.", p_sample_name: null, p_source_type: null, p_origin: "suggestion" });
    A.busy = false;
    if (r.error) A.msg = `Not queued: ${r.error.message || r.error}`;
    else {
      const d = r.data || {}, wait = d.already_waiting || [], inset = d.already_on_unsequenced_sample_set || [];
      A.msg = `${d.added || 0} phage${d.added === 1 ? "" : "s"} ${d.status === "requested" ? "requested (an editor confirms the request)" : "added to the sequencing queue"}.${wait.length ? ` Already waiting: ${wait.join(", ")}.` : ""}${inset.length ? ` Already on a sample set not yet sequenced: ${inset.join(", ")}.` : ""}`;
      A.sel = new Set();
      const qr = await sb.from("sequencing_requests").select("phage_id,status").in("status", ["requested", "queued"]);
      if (!qr.error) A.queued = new Set((qr.data || []).map((x) => x.phage_id));
    }
    render();
  }
  const OBS_RANK = { "No digestion": 3, "Partial digestion": 2, "Uninterpretable": 1, "Digestion": 0 };
  const shareOf = (x) => (x.n ? x.b / x.n : -1);
  const has = (v, f) => !f || String(v || "").toLowerCase().includes(String(f).trim().toLowerCase());
  const sorted = (list, key, dir, name) => list.slice().sort((x, y) => { const a = key(x), b = key(y); return (a < b ? -1 : a > b ? 1 : 0) * dir || String(name(x)).localeCompare(String(name(y))); });
  // Everything the analysis page shows, worked out once: the phage rows, and the rows of the two figures.
  function analysisModel() {
    const A = S.an, used = usedEnzymes([...A.by.values()]);
    const all = S.catalog.filter((p) => A.by.has(p.phage_id)).map((p) => phageRow(p, A.by.get(p.phage_id), used, A.checked.get(p.phage_id)));
    const hosts = [...new Set(all.map((r) => r.host).filter(Boolean))].sort();
    if (A.enz && !used.some((z) => z.restriction_enzyme_id === A.enz)) A.enz = "";   // a remembered filter that no longer applies
    if (A.host && !hosts.includes(A.host)) A.host = "";
    const q = A.q.trim().toLowerCase(), min = Number(A.min) || 0, one = (list) => (A.enz ? list.some((z) => z.restriction_enzyme_id === A.enz) : list.length > 0);
    const keyMain = (k) => (k === "name" ? (r) => r.name.toLowerCase() : k === "id" ? (r) => Number(labId(r.p)) || 0 : k === "host" ? (r) => r.host.toLowerCase() : k === "cluster" ? (r) => r.cluster.toLowerCase()
      : k === "genome" ? (r) => r.p.genome_length_bp || 0 : k === "blocked" ? (r) => r.blk.length : k === "chk" ? (r) => (r.chk.n ? r.chk.c / r.chk.n : -1)
      : (r) => { const c = r.m.get(k); return c ? (c.blocked ? 4 : OBS_RANK[c.obs] || 0) : -1; });
    const rows = sorted(all.filter((r) => (!q || r.name.toLowerCase().includes(q) || String(r.p.phagesdb_cluster || "").toLowerCase() === q)
      && (A.show === "blocked" ? one(r.blk) : A.show === "confirmed" ? one(r.sure) : !A.enz || r.m.has(A.enz))
      && r.blk.length >= min && (!A.seq || (A.seq === "yes") === !!r.p.genome_length_bp) && (!A.host || r.host === A.host)), keyMain(A.sort.k), A.sort.dir, (r) => r.name);
    const base = A.follow ? rows : all;
    // figure 1: one row per host, cluster or subcluster
    const gkey = A.fig === "cluster" ? (r) => r.p.phagesdb_cluster : A.fig === "subcluster" ? (r) => r.p.phagesdb_subcluster : (r) => r.host;
    const gm = new Map(); let none = 0;
    for (const r of base) { const g = gkey(r); if (!g) { none += 1; continue; } if (!gm.has(g)) gm.set(g, []); gm.get(g).push(r); }
    const F1 = A.f1.f, f1all = [...gm].map(([g, rs]) => { const cells = new Map(); for (const z of used) { let n = 0, b = 0; for (const r of rs) { const c = r.m.get(z.restriction_enzyme_id); if (c) { n += 1; if (c.blocked) b += 1; } } cells.set(z.restriction_enzyme_id, { n, b }); } return { g, n: rs.length, ge3: rs.filter((r) => r.blk.length >= 3).length, cells }; });
    const f1 = sorted(f1all.filter((x) => has(x.g, F1.q) && x.n >= (Number(F1.minN) || 0) && x.ge3 >= (Number(F1.min3) || 0)
      && used.every((z) => { const f = F1[z.restriction_enzyme_id], c = x.cells.get(z.restriction_enzyme_id); return !f || (f === "some" ? c.b > 0 : c.n > 0 && c.b === 0); })),
      A.f1.sort.k === "g" ? (x) => String(x.g).toLowerCase() : A.f1.sort.k === "n" ? (x) => x.n : A.f1.sort.k === "ge3" ? (x) => x.ge3 : (x) => shareOf(x.cells.get(A.f1.sort.k) || { n: 0, b: 0 }), A.f1.sort.dir, (x) => x.g);
    // figure 2: one row per phage, G/C against A/T
    const F2 = A.f2.f, k2 = A.f2.sort.k;
    const f2 = sorted(base.filter((r) => has(r.name, F2.q) && has(r.host, F2.host) && has(r.cluster, F2.cluster) && (!F2.seq || (F2.seq === "yes") === !!r.p.genome_length_bp) && (!F2.call || r.call === F2.call) && (!F2.ev || r.ev === F2.ev)),
      k2 === "name" ? (r) => r.name.toLowerCase() : k2 === "host" ? (r) => r.host.toLowerCase() : k2 === "cluster" ? (r) => r.cluster.toLowerCase() : k2 === "genome" ? (r) => r.p.genome_length_bp || 0
        : k2 === "call" ? (r) => r.call : k2 === "ev" ? (r) => r.ev : (r) => shareOf(r[k2]) * 1000 + r[k2].b, A.f2.sort.dir, (r) => r.name);
    // figure 3: each combination of blocked enzymes, and how many phages show it
    const pm = new Map(); let unblocked = 0;
    for (const r of base) {
      if (!r.blk.length) { unblocked += 1; continue; }
      const key = r.blk.map((z) => z.enzyme_name).join(" + "), host = r.host || "(no host)";
      let x = pm.get(key);
      if (!x) { x = { key, k: r.blk.length, n: 0, hosts: new Map(), names: [], g: { gc: 0, at: 0, both: 0 } }; for (const z of r.blk) x.g[z.grp] += 1; pm.set(key, x); }
      x.n += 1; x.names.push(r.name); x.hosts.set(host, (x.hosts.get(host) || 0) + 1);
    }
    const F3 = A.f3.f, toks = String(F3.q || "").toLowerCase().split(/[\s,+]+/).filter(Boolean), k3 = A.f3.sort.k;
    const f3all = [...pm.values()].map((x) => Object.assign(x, { hostText: [...x.hosts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([h, n]) => `${h} (${n})`).join(", ") }));
    const f3 = sorted(f3all.filter((x) => toks.every((t) => x.key.toLowerCase().includes(t)) && x.n >= (Number(F3.minN) || 0) && x.k >= (Number(F3.minK) || 0) && has(x.hostText, F3.host)),
      k3 === "key" ? (x) => x.key.toLowerCase() : k3 === "k" ? (x) => x.k : k3 === "host" ? (x) => x.hostText.toLowerCase() : (x) => x.n, A.f3.sort.dir, (x) => x.key);
    // figure 4: modification gene islands, set beside the digest call of the same phage
    const callOf = new Map(all.map((r) => [r.p.phage_id, r])), F4 = A.f4.f, k4 = A.f4.sort.k, f4all = [];
    let islPhages = 0, geneTotal = 0, unnamed = 0;
    for (const p of S.catalog) {
      const I = A.isl.get(p.phage_id); if (!I) continue;
      geneTotal += I.total; unnamed += I.total - I.named; if (I.islands.length) islPhages += 1;
      const r = callOf.get(p.phage_id), call = r && (r.gc.n + r.at.n) ? r.call : "";
      for (const x of I.islands) f4all.push(Object.assign({}, x, { p, name: p.phage_name || "", host: hostOf(p), cluster: p.phagesdb_subcluster || p.phagesdb_cluster || "", call,
        match: !call || x.cls === "Not stated" ? "" : (call === x.cls || call === "G/C and A/T" && x.cls !== "Not stated" || x.cls === "G/C and A/T" && (call === "G/C" || call === "A/T")) ? "agree" : "differ" }));
    }
    const f4 = sorted(f4all.filter((x) => has(x.name, F4.q) && has(x.host, F4.host) && has(x.cluster, F4.cluster) && (!F4.src || x.src === F4.src) && (!F4.kind || x.kind === F4.kind) && (!F4.strength || x.strength === F4.strength) && (!F4.cls || x.cls === F4.cls)
      && has(x.hits.map(hitLabel).join(" "), F4.gene) && (!F4.call || (F4.call === "any" ? !!x.call : x.match === F4.call))),
      k4 === "name" ? (x) => x.name.toLowerCase() : k4 === "host" ? (x) => x.host.toLowerCase() : k4 === "cluster" ? (x) => x.cluster.toLowerCase() : k4 === "kind" ? (x) => x.kind : k4 === "src" ? (x) => x.src : k4 === "strength" ? (x) => ["Supporting genes only", "Moderate", "Strong"].indexOf(x.strength)
        : k4 === "lo" ? (x) => x.lo : k4 === "cls" ? (x) => x.cls : k4 === "call" ? (x) => x.call + x.match : (x) => x.hits.length * 10 + x.hits.filter((h) => h.m.core).length, A.f4.sort.dir, (x) => x.name);
    return { used, all, hosts, rows, base, none, f1, f1total: f1all.length, f2, f3, f3total: f3all.length, unblocked, f4, f4total: f4all.length, islPhages, annotated: A.isl.size, geneTotal, unnamed };
  }
  function analysisCell(c, first) {
    const g0 = first ? " g0" : "";
    if (!c) return `<td class="c${g0}"></td>`;
    const sure = c.blocked && c.ctl && !!c.virt;
    const why = c.blocked && !sure ? [c.virt ? "" : "no genome sequence, so presumed blocked", c.ctl ? "" : c.noctl ? "no control digest was run" : "control digest not confirmed"].filter(Boolean).join(" · ") : "";
    const tip = `${c.obs} · virtual digest: ${c.virt || "no genome sequence"} · ${c.date || "no date"}${why ? " · " + why : ""}${c.n > 1 ? ` · latest of ${c.n} digests${c.mixed ? ", and their results differ" : ""}` : ""}`;
    const mark = c.mixed ? '<sup title="Digests of this phage disagree for this enzyme">≠</sup>' : "";
    if (c.blocked) return `<td class="c ${sure ? "blk" : "blkq"}${g0}" title="Blocked${sure ? "" : " (provisional)"} · ${esc(tip)}"><b>✗</b>${mark}</td>`;
    const k = c.obs === "Digestion" ? ["✓", "ok"] : c.obs === "Partial digestion" ? ["~", "warn"] : c.obs === "No digestion" ? ["✗", "mute"] : ["?", "mute"];
    return `<td class="c ${k[1]}${g0}" title="${esc(tip)}">${k[0]}${mark}</td>`;
  }
  const TEXT_KEYS = new Set(["name", "id", "host", "cluster", "g", "call", "ev", "key", "kind", "cls", "lo", "src"]);
  const sortTh = (tbl, st, k, label, cls, title, extra) => `<th class="${cls || ""}" data-asort="${tbl}:${k}" title="${esc(title || "Sort by this column")}"${extra || ""}>${label} <span class="arrow">${st.sort.k === k ? (st.sort.dir > 0 ? "▲" : "▼") : ""}</span></th>`;
  const shade = (x, title) => (x.n ? `<td class="c" style="background:rgba(21,88,160,${((x.b / x.n) * 0.95).toFixed(2)});color:${x.b / x.n > 0.5 ? "#fff" : "inherit"}" title="${esc(title)}: blocked in ${x.b} of ${x.n} tested (${Math.round((x.b / x.n) * 100)}%)">${x.b}/${x.n}</td>` : '<td class="c mute" title="Not tested">–</td>');
  const selOpt = (v, label, cur) => `<option value="${esc(v)}"${String(cur || "") === String(v) ? " selected" : ""}>${esc(label)}</option>`;
  function figureGroups(M) {
    const A = S.an, F = A.f1.f, what = A.fig === "cluster" ? "PhagesDB cluster" : A.fig === "subcluster" ? "PhagesDB subcluster" : "host";
    return `<details class="sec" data-sec="fig"${S.open.fig === false ? "" : " open"}><summary><b>Figure 1:</b> blocked enzymes by ${what} <span class="sub">(${M.f1.length} of ${M.f1total} group${M.f1total === 1 ? "" : "s"})</span></summary>
      <div class="row anbar" style="margin-left:12px"><label class="check">Group by <select data-an="fig">${selOpt("host", "host", A.fig)}${selOpt("cluster", "cluster", A.fig)}${selOpt("subcluster", "subcluster", A.fig)}</select></label>
      <span class="dl">Download: <button class="mini" data-adl="f1.csv">table (CSV)</button><button class="mini" data-adl="f1.png">image</button></span>
      <span class="sub">Each cell: phages blocked / phages tested with that enzyme; darker means a larger share blocked. Click a heading to sort.${M.none ? ` ${fmt(M.none)} phage${M.none === 1 ? " has" : "s have"} no ${what} and ${M.none === 1 ? "is" : "are"} left out.` : ""}</span></div>
      <div class="tablescroll" style="margin:0 12px 10px"><table class="list an fig fig1"><thead><tr>${sortTh("f1", A.f1, "g", what.charAt(0).toUpperCase() + what.slice(1))}${sortTh("f1", A.f1, "n", "Phages", "c")}${sortTh("f1", A.f1, "ge3", "3+ blocked", "c", "Phages with three or more blocked enzymes")}${M.used.map((z, i) => sortTh("f1", A.f1, z.restriction_enzyme_id, esc(z.enzyme_name), "c" + (i && M.used[i - 1].grp !== z.grp ? " g0" : ""), `${z.recognition_sequence || ""} · ${(SITE_GROUPS.find((g) => g[0] === z.grp) || [])[1]}`)).join("")}</tr>
      <tr class="filters"><td><input data-ain="f1.f.q" value="${esc(F.q || "")}" placeholder="filter"></td><td><input data-ain="f1.f.minN" value="${esc(F.minN || "")}" placeholder="min" inputmode="numeric"></td><td><input data-ain="f1.f.min3" value="${esc(F.min3 || "")}" placeholder="min" inputmode="numeric"></td>${M.used.map((z) => `<td><select data-an="f1.f.${z.restriction_enzyme_id}">${selOpt("", "all", F[z.restriction_enzyme_id])}${selOpt("some", "blocked", F[z.restriction_enzyme_id])}${selOpt("none", "none", F[z.restriction_enzyme_id])}</select></td>`).join("")}</tr></thead><tbody>
      ${M.f1.map((x) => `<tr><td><b>${esc(x.g)}</b></td><td class="c">${x.n}</td><td class="c">${x.ge3}</td>${M.used.map((z) => shade(x.cells.get(z.restriction_enzyme_id), z.enzyme_name)).join("")}</tr>`).join("") || `<tr><td colspan="${M.used.length + 3}" class="sub">No group matches these filters.</td></tr>`}
      </tbody></table></div></details>`;
  }
  const CALLS2 = ["G/C", "A/T", "G/C and A/T", "Unclear", "None seen", "Not tested"], EVS = ["Genome-checked", "Lab gel only", "Weak: A/T sites unconfirmed"];
  function figureGcAt(M) {
    const A = S.an, F = A.f2.f, n = A.f2.size === "all" ? M.f2.length : Number(A.f2.size) || 10, shown = M.f2.slice(0, n);
    const count = (c) => M.base.filter((r) => r.call === c).length;
    const gcNames = M.used.filter((z) => z.grp === "gc").map((z) => z.enzyme_name).join(", "), atNames = M.used.filter((z) => z.grp === "at").map((z) => z.enzyme_name).join(", ");
    return `<details class="sec" data-sec="fig2"${S.open.fig2 === false ? "" : " open"}><summary><b>Figure 2:</b> phages most likely G/C modified or A/T modified <span class="sub">(G/C ${count("G/C")} · A/T ${count("A/T")} · both ${count("G/C and A/T")} of ${M.base.length} phages)</span></summary>
      <div class="row anbar" style="margin-left:12px"><label class="check">Show <select data-an="f2.size">${["10", "25", "50", "100"].map((v) => selOpt(v, `first ${v}`, A.f2.size)).join("")}${selOpt("all", "all", A.f2.size)}</select></label>
      <span class="dl">Download: <button class="mini" data-adl="f2.csv">table (CSV)</button><button class="mini" data-adl="f2.png">table image</button><button class="mini" data-adl="f2s.png">plot image</button></span>
      <span class="sub">${shown.length} of ${M.f2.length} phages shown. Click a heading to sort, a row to open the phage.</span></div>
      ${scatterGcAt(M.f2)}
      <div class="tablescroll" style="margin:0 12px 6px"><table class="list an fig fig2"><thead><tr>${sortTh("f2", A.f2, "name", "Phage")}${sortTh("f2", A.f2, "host", "Host")}${sortTh("f2", A.f2, "cluster", "Cluster")}${sortTh("f2", A.f2, "genome", "Genome")}${sortTh("f2", A.f2, "gc", "G/C sites", "c g0", `Blocked / tested among: ${gcNames || "none tested"}`)}${sortTh("f2", A.f2, "at", "A/T sites", "c", `Blocked / tested among: ${atNames || "none tested"}`)}${sortTh("f2", A.f2, "both", "Mixed sites", "c", "Blocked / tested among enzymes whose site has both G/C and A/T")}${sortTh("f2", A.f2, "call", "Likely modified", "g0")}${sortTh("f2", A.f2, "ev", "Evidence")}</tr>
      <tr class="filters"><td><input data-ain="f2.f.q" value="${esc(F.q || "")}" placeholder="filter"></td><td><input data-ain="f2.f.host" value="${esc(F.host || "")}" placeholder="filter"></td><td><input data-ain="f2.f.cluster" value="${esc(F.cluster || "")}" placeholder="filter"></td><td><select data-an="f2.f.seq">${selOpt("", "all", F.seq)}${selOpt("yes", "sequenced", F.seq)}${selOpt("no", "not sequenced", F.seq)}</select></td><td></td><td></td><td></td><td><select data-an="f2.f.call">${selOpt("", "all", F.call)}${CALLS2.map((c) => selOpt(c, c, F.call)).join("")}</select></td><td><select data-an="f2.f.ev">${selOpt("", "all", F.ev)}${EVS.map((c) => selOpt(c, c, F.ev)).join("")}</select></td></tr></thead><tbody>
      ${shown.map((r) => `<tr data-go="#/phage/${r.p.phage_id}"><td><b>${esc(r.name)}</b></td><td>${esc(r.host)}</td><td>${esc(r.cluster)}</td><td>${r.p.genome_length_bp ? fmt(r.p.genome_length_bp) + " bp" : '<span class="sub">no sequence</span>'}</td>${shade(r.gc, "G/C-site enzymes").replace('class="c"', 'class="c g0"').replace('class="c mute"', 'class="c mute g0"')}${shade(r.at, "A/T-site enzymes")}${shade(r.both, "Mixed-site enzymes")}<td class="g0">${r.call === "G/C" || r.call === "A/T" || r.call === "G/C and A/T" ? chip(r.call, "warn") : `<span class="sub">${esc(r.call)}</span>`}</td><td class="${/^Weak/.test(r.ev) ? "warn" : ""}">${esc(r.ev)}</td></tr>`).join("") || '<tr><td colspan="9" class="sub">No phage matches these filters.</td></tr>'}
      </tbody></table></div>
      <p class="tiny" style="margin:0 12px 10px"><b>How the call is made.</b> G/C: at least two enzymes whose site is only G and C (${esc(gcNames || "none tested")}) are blocked, and they are at least half of those tested. A/T: at least half of the A/T-only enzymes tested (${esc(atNames || "none tested")}) are blocked. This is a screening rule, not proof. <b>Weak</b>: an A/T call on a phage with no genome sequence, where "not cut" may only mean the genome has no site for the enzyme. <b>Genome-checked</b>: every blocked enzyme has sites in the genome sequence.</p></details>`;
  }
  // ---------- DNA modification gene islands ----------
  // Gene products tied to known phage DNA modification pathways. base: the DNA base the pathway changes ("?" when the product name
  // does not say). core: specific to DNA modification; the others only support an island and never make one alone.
  // Sources: Weigele & Raleigh 2016 (doi:10.1021/acs.chemrev.6b00114); Lee et al. 2018 (doi:10.1073/pnas.1714812115);
  // Hutinet et al. 2019 (doi:10.1038/s41467-019-13384-y); Sleiman et al. 2021 (doi:10.1126/science.abe6494); Czernecki et al. 2021 (doi:10.1038/s41467-021-25064-x).
  const MOD_MARKERS = [
    { re: /dcmp hydroxymethyl|deoxycytidylate hydroxymethyl/i, name: "dCMP hydroxymethylase", base: "C", path: "5-hydroxymethylcytosine", core: true },
    { re: /\bglucosyl ?transferase/i, name: "glucosyltransferase", base: "C", path: "glucosylated hydroxymethylcytosine", core: true },
    { re: /dctp(ase| pyrophosphatase| diphosphatase)/i, name: "dCTPase", base: "C", path: "5-hydroxymethylcytosine (keeps dCTP out of the DNA)", core: false },
    { re: /(cytosine|\bdcm\b|c-?5)[^,;]{0,40}(methyl ?transferase|methylase)|(methyl ?transferase|methylase)[^,;]{0,20}(cytosine|\bdcm\b)/i, name: "cytosine methyltransferase", base: "C", path: "methylcytosine", core: true },
    { re: /(adenine|\bdam\b|n-?6)[^,;]{0,40}(methyl ?transferase|methylase)|(methyl ?transferase|methylase)[^,;]{0,20}(adenine|\bdam\b)/i, name: "adenine methyltransferase", base: "A", path: "N6-methyladenine", core: true },
    { re: /\bmom\b|momylation/i, name: "Mom", base: "A", path: "N6-carbamoylmethyladenine", core: true },
    { re: /\bpurz\b|adenylosuccinate synth/i, name: "PurZ-like adenylosuccinate synthetase", base: "A", path: "2-aminoadenine in place of adenine", core: true },
    { re: /\bdatz\b|datp (triphospho)?hydrolase|\bdatpase\b/i, name: "DatZ dATPase", base: "A", path: "2-aminoadenine in place of adenine", core: true },
    { re: /\bmaz[gz]\b|(nucleotide|ntp|nucleoside triphosphate) pyrophosphohydrolase/i, name: "MazG-like pyrophosphohydrolase", base: "A", path: "2-aminoadenine (MazZ); also common in other roles", core: false },
    { re: /\bdpda\d?\b|trna-guanine transglycosylase|queuine trna-ribosyltransferase/i, name: "DpdA / tRNA-guanine transglycosylase homologue", base: "G", path: "7-deazaguanine", core: true },
    { re: /\bquec\b|7-cyano-7-deazaguanine synth/i, name: "QueC", base: "G", path: "7-deazaguanine", core: true },
    { re: /\bqued\b|6-carboxy[^,;]{0,14}tetrahydropterin synth/i, name: "QueD", base: "G", path: "7-deazaguanine", core: true },
    { re: /\bquee\b|7-carboxy-7-deazaguanine synth/i, name: "QueE", base: "G", path: "7-deazaguanine", core: true },
    { re: /\bquef\b|preq0? reductase|7-cyano-7-deazaguanine reductase/i, name: "QueF", base: "G", path: "7-deazaguanine", core: true },
    { re: /\bfole\b|gtp cyclohydrolase/i, name: "GTP cyclohydrolase I (FolE)", base: "G", path: "7-deazaguanine (shared with folate synthesis)", core: false },
    { re: /glutamine amidotransferase|\barcs\b|archaeosine/i, name: "amidotransferase (Gat / ArcS)", base: "G", path: "7-deazaguanine (last steps)", core: false },
    { re: /dump hydroxymethyl|deoxyuridylate hydroxymethyl|5-?hmdu|hydroxymethyl ?(deoxy)?urid|hydroxymethyluracil/i, name: "dUMP hydroxymethyltransferase / 5-hmdU enzyme", base: "T", path: "hypermodified thymine", core: true },
    { re: /pplase|putrescinyl|glutamyl.?thymi|thymine pyrophosphorylase/i, name: "aGPT-Pplase", base: "T", path: "hypermodified thymine", core: true },
    { re: /thymidylate synthase/i, name: "thymidylate synthase", base: "T", path: "hypermodified thymine (the hydroxymethylase is a homologue); also ordinary dTMP synthesis", core: false },
    { re: /dna[^,;]{0,14}(methyl ?transferase|methylase)|(methyl ?transferase|methylase)[^,;]{0,14}dna|\bmethylase\b/i, name: "DNA methyltransferase", base: "?", path: "DNA methylation (base not stated)", core: true },
    { re: /methyl ?transferase/i, name: "methyltransferase (target not stated)", base: "?", path: "methylation (may not act on DNA)", core: false },
    { re: /\bglycosyl ?transferase/i, name: "glycosyltransferase", base: "?", path: "sugar modification (of DNA, or of the cell wall)", core: false }
  ];
  const ISLAND_BP = 10000;   // marker genes no further apart than this belong to one island
  const markerOf = (g) => { const t = `${g.product || ""} ${g.gene_name || ""}`; return MOD_MARKERS.find((m) => m.re.test(t)) || null; };
  const baseClass = (bases) => { const gc = bases.some((b) => b === "C" || b === "G"), at = bases.some((b) => b === "A" || b === "T"); return gc && at ? "G/C and A/T" : gc ? "G/C" : at ? "A/T" : "Not stated"; };
  // The islands of one phage: marker genes within ISLAND_BP of each other (two or more), plus any core marker gene standing alone.
  function findIslands(genes) {
    const bySrc = new Map(); for (const g of genes) { if (!bySrc.has(g.source)) bySrc.set(g.source, []); bySrc.get(g.source).push(g); }
    let best = null;
    for (const [src, list] of bySrc) {
      const sorted = list.slice().sort((a, b) => (a.start_bp || 0) - (b.start_bp || 0)), hits = sorted.map((g) => ({ g, m: markerOf(g) })).filter((x) => x.m);
      const core = hits.filter((h) => h.m.core).length;   // where a phage has two annotations, use the one with more core genes; the lab's own on a tie
      if (!best || core > best.core || (core === best.core && src === "lab")) best = { src, sorted, hits, core };
    }
    if (!best) return { src: "", named: 0, total: 0, islands: [] };
    const groups = []; let cur = [];
    for (const h of best.hits) { if (cur.length && Math.min(h.g.start_bp, h.g.end_bp) - Math.max(cur[cur.length - 1].g.start_bp, cur[cur.length - 1].g.end_bp) > ISLAND_BP) { groups.push(cur); cur = []; } cur.push(h); }
    if (cur.length) groups.push(cur);
    const islands = [];
    for (const grp of groups) {
      const core = grp.filter((h) => h.m.core);
      if (grp.length < 2 && !core.length) continue;
      const lo = Math.min(...grp.map((h) => Math.min(h.g.start_bp, h.g.end_bp))), hi = Math.max(...grp.map((h) => Math.max(h.g.start_bp, h.g.end_bp)));
      const bases = [...new Set(core.map((h) => h.m.base).filter((b) => b !== "?"))].sort();   // only core genes say which base is changed
      islands.push({ src: best.src, kind: grp.length >= 2 ? "Island" : "Single gene", strength: core.length >= 2 ? "Strong" : core.length ? "Moderate" : "Supporting genes only", hits: grp, lo, hi, bases, cls: baseClass(bases),
        inside: best.sorted.filter((g) => Math.max(g.start_bp, g.end_bp) >= lo && Math.min(g.start_bp, g.end_bp) <= hi) });
    }
    return { src: best.src, total: best.sorted.length, named: best.sorted.filter((g) => g.product && !/hypothetical|unknown function/i.test(g.product)).length, islands };
  }
  function buildIslands() {
    const A = S.an, by = new Map();
    for (const g of A.genes || []) { if (!by.has(g.phage_id)) by.set(g.phage_id, []); by.get(g.phage_id).push(g); }
    A.isl = new Map([...by].map(([id, genes]) => [id, findIslands(genes)]));
  }
  const BASE_COLORS = { C: "#0072B2", G: "#009E73", A: "#D55E00", T: "#E69F00", "?": "#7a7f87" };
  // A small map of one island: its genes in order, marker genes coloured by the base their pathway changes.
  function islandMap(x) {
    const W = 230, H = 22, span = Math.max(1, x.hi - x.lo), X = (bp) => 2 + ((bp - x.lo) / span) * (W - 4);
    const marks = new Map(x.hits.map((h) => [h.g.gene_key, h.m]));
    return `<svg class="imap" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="${H / 2}" x2="${W - 2}" y2="${H / 2}" stroke="#c9ced6"/>${x.inside.map((g) => { const m = marks.get(g.gene_key), a = X(Math.min(g.start_bp, g.end_bp)), b = X(Math.max(g.start_bp, g.end_bp)); return `<rect x="${a.toFixed(1)}" y="${m ? 3 : 7}" width="${Math.max(1.5, b - a - 0.6).toFixed(1)}" height="${m ? H - 6 : H - 14}" rx="1.5" fill="${m ? BASE_COLORS[m.base] : "#d5d9df"}"${m && !m.core ? ' fill-opacity="0.5"' : ""}><title>${esc(`gene ${g.gene_number || ""}: ${g.product || "no product name"}${m ? ` · ${m.name} · ${m.path}` : ""}`)}</title></rect>`; }).join("")}</svg>`;
  }
  const hitLabel = (h) => `${h.m.name}${h.g.gene_number ? ` (gene ${h.g.gene_number})` : ""}`;
  function figureIslands(M) {
    const A = S.an, F = A.f4.f, n = A.f4.size === "all" ? M.f4.length : Number(A.f4.size) || 15, shown = M.f4.slice(0, n);
    const legend = [["C", "cytosine"], ["G", "guanine"], ["A", "adenine"], ["T", "thymine"], ["?", "base not stated"]].map(([b, t]) => `<span class="lg"><i style="background:${BASE_COLORS[b]}"></i>${t}</span>`).join("");
    return `<details class="sec" data-sec="fig4"${S.open.fig4 === false ? "" : " open"}><summary><b>Figure 4:</b> DNA modification gene islands <span class="sub">(${M.f4.length} of ${M.f4total} found in ${M.islPhages} of ${M.annotated} annotated genomes)</span></summary>
      <div class="row anbar" style="margin-left:12px"><label class="check">Show <select data-an="f4.size">${["15", "30", "60"].map((v) => selOpt(v, `first ${v}`, A.f4.size)).join("")}${selOpt("all", "all", A.f4.size)}</select></label>
      <span class="dl">Download: <button class="mini" data-adl="f4.csv">table (CSV)</button><button class="mini" data-adl="f4.png">image</button></span>
      <span class="sub">An island is two or more modification-related genes within ${fmt(ISLAND_BP / 1000)} kb of each other; a core modification gene standing alone is listed as a single gene. Map: ${legend} · pale = supporting gene · grey = other genes.</span></div>
      ${M.annotated ? "" : '<p class="sub" style="margin:0 12px 8px">No annotated genome could be read, so there is nothing to search.</p>'}
      <div class="tablescroll" style="margin:0 12px 6px"><table class="list an fig fig4"><thead><tr>${sortTh("f4", A.f4, "name", "Phage")}${sortTh("f4", A.f4, "host", "Host")}${sortTh("f4", A.f4, "cluster", "Cluster")}${sortTh("f4", A.f4, "src", "Annotation", "", "Which gene list was searched: the lab's own annotation or the PhagesDB one")}${sortTh("f4", A.f4, "kind", "Type", "g0")}${sortTh("f4", A.f4, "strength", "Evidence")}${sortTh("f4", A.f4, "ngenes", "Genes", "c")}${sortTh("f4", A.f4, "lo", "Position")}<th>Map</th><th>Modification genes</th>${sortTh("f4", A.f4, "cls", "Predicted", "g0", "The kind of base the island's pathways change")}${sortTh("f4", A.f4, "call", "Digest call", "", "The likely modification from the restriction digests of the same phage (Figure 2)")}</tr>
      <tr class="filters"><td><input data-ain="f4.f.q" value="${esc(F.q || "")}" placeholder="filter"></td><td><input data-ain="f4.f.host" value="${esc(F.host || "")}" placeholder="filter"></td><td><input data-ain="f4.f.cluster" value="${esc(F.cluster || "")}" placeholder="filter"></td><td><select data-an="f4.f.src">${selOpt("", "all", F.src)}${selOpt("lab", "lab", F.src)}${selOpt("phagesdb", "PhagesDB", F.src)}</select></td><td><select data-an="f4.f.kind">${selOpt("", "all", F.kind)}${selOpt("Island", "islands", F.kind)}${selOpt("Single gene", "single genes", F.kind)}</select></td><td><select data-an="f4.f.strength">${selOpt("", "all", F.strength)}${["Strong", "Moderate", "Supporting genes only"].map((v) => selOpt(v, v, F.strength)).join("")}</select></td><td></td><td></td><td></td><td><input data-ain="f4.f.gene" value="${esc(F.gene || "")}" placeholder="gene, e.g. methyl"></td><td><select data-an="f4.f.cls">${selOpt("", "all", F.cls)}${["G/C", "A/T", "G/C and A/T", "Not stated"].map((v) => selOpt(v, v, F.cls)).join("")}</select></td><td><select data-an="f4.f.call">${selOpt("", "all", F.call)}${selOpt("any", "has digests", F.call)}${selOpt("agree", "agrees", F.call)}${selOpt("differ", "differs", F.call)}</select></td></tr></thead><tbody>
      ${shown.map((x) => `<tr data-go="#/phage/${x.p.phage_id}"><td><b>${esc(x.name)}</b></td><td>${esc(x.host)}</td><td>${esc(x.cluster)}</td><td>${x.src === "lab" ? "lab" : "PhagesDB"}</td><td class="g0">${esc(x.kind)}</td><td class="${x.strength === "Strong" ? "ok" : x.strength === "Moderate" ? "" : "sub"}">${esc(x.strength)}</td><td class="c">${x.hits.length}</td><td class="mono">${fmt(x.lo)}–${fmt(x.hi)}</td><td>${islandMap(x)}</td><td>${esc(x.hits.map(hitLabel).join("; "))}</td><td class="g0">${x.cls === "Not stated" ? '<span class="sub">not stated</span>' : chip(x.cls, "warn")}${x.bases.length ? ` <span class="sub">${esc(x.bases.join(", "))}</span>` : ""}</td><td>${!x.call ? '<span class="sub">no digests</span>' : `${esc(x.call)} ${x.match === "agree" ? '<span class="ok" title="The digests point to the same kind of base">✓ agrees</span>' : x.match === "differ" ? '<span class="warn" title="The digests point elsewhere, or show no block">differs</span>' : ""}`}</td></tr>`).join("") || `<tr><td colspan="12" class="sub">${M.f4total ? "No island matches these filters." : "No modification gene was recognised in the annotated genomes."}</td></tr>`}
      </tbody></table></div>
      <p class="tiny" style="margin:0 12px 10px"><b>How islands are found.</b> Each gene's product name is compared with a list of enzymes from known phage DNA modification pathways: hydroxymethylcytosine and its glucosylation, DNA methylation, 7-deazaguanine (DpdA, QueC, QueD, QueE, QueF), 2-aminoadenine (PurZ, DatZ, MazZ) and hypermodified thymine (5-hmdU enzymes). Core enzymes are specific to DNA modification; supporting ones (a glycosyltransferase, thymidylate synthase, a MazG-like enzyme) also have everyday roles and count only beside others, and an island made of supporting genes alone gets no predicted base. Where a phage has both a lab annotation and a PhagesDB one, the one with more core genes is used. Genes named "hypothetical protein" cannot be recognised, so an empty result is not proof of absence: ${fmt(M.unnamed)} of ${fmt(M.geneTotal)} genes have no informative name. This is a screen, not proof of a modification.</p></details>`;
  }
  // Figure 2's plot: one dot per phage, share of G/C-site enzymes blocked against share of A/T-site enzymes blocked.
  const GENUS_COLORS = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00"];
  function scatterGcAt(rows) {
    const pts = rows.filter((r) => r.gc.n && r.at.n), L = 56, T = 12, P = 250, pad = 14;
    if (!pts.length) return '<p class="sub" style="margin:0 12px 8px">No phage here has been tested with both a G/C-site and an A/T-site enzyme, so there is nothing to plot.</p>';
    const cnt = new Map(); for (const r of pts) { const g = r.p.host_genus || "(no host)"; cnt.set(g, (cnt.get(g) || 0) + 1); }
    const genera = [...cnt].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), col = (g) => { const i = genera.findIndex((x) => x[0] === g); return i >= 0 && i < GENUS_COLORS.length ? GENUS_COLORS[i] : "#8a8f98"; };
    const jit = (s, salt) => { let h = 2166136261 ^ salt; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); h ^= h >>> 13; h = Math.imul(h, 1540483477); h ^= h >>> 15; return ((h >>> 0) / 4294967296 - 0.5) * 0.11; };   // a fixed small nudge per phage
    const X = (v) => L + pad + v * (P - 2 * pad), Y = (v) => T + P - pad - v * (P - 2 * pad);
    const ticks = [0, 0.5, 1].map((v) => `<line x1="${X(v)}" y1="${T}" x2="${X(v)}" y2="${T + P}" stroke="#e3e6ea" stroke-dasharray="${v === 0.5 ? "4 3" : "0"}"/><line x1="${L}" y1="${Y(v)}" x2="${L + P}" y2="${Y(v)}" stroke="#e3e6ea" stroke-dasharray="${v === 0.5 ? "4 3" : "0"}"/><text x="${X(v)}" y="${T + P + 15}" text-anchor="middle">${v * 100}%</text><text x="${L - 7}" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join("");
    const dots = pts.map((r) => `<a href="#/phage/${r.p.phage_id}"><circle cx="${(X(r.gc.b / r.gc.n) + jit(r.p.phage_id, 7) * P).toFixed(1)}" cy="${(Y(r.at.b / r.at.n) + jit(r.p.phage_id, 53) * P).toFixed(1)}" r="3.8" fill="${col(r.p.host_genus || "(no host)")}" fill-opacity="0.72" stroke="#fff" stroke-width="0.7"><title>${esc(r.name)} · ${esc(r.host)} · G/C sites ${r.gc.b}/${r.gc.n} blocked · A/T sites ${r.at.b}/${r.at.n} blocked · ${esc(r.call)}</title></circle></a>`).join("");
    const legend = genera.slice(0, GENUS_COLORS.length).map(([g, n], i) => `<circle cx="${L + P + 26}" cy="${T + 22 + i * 19}" r="5" fill="${GENUS_COLORS[i]}"/><text x="${L + P + 37}" y="${T + 26 + i * 19}"><tspan font-style="italic">${esc(g)}</tspan> (${n})</text>`).join("")
      + (genera.length > GENUS_COLORS.length ? `<circle cx="${L + P + 26}" cy="${T + 22 + GENUS_COLORS.length * 19}" r="5" fill="#8a8f98"/><text x="${L + P + 37}" y="${T + 26 + GENUS_COLORS.length * 19}">other hosts (${genera.slice(GENUS_COLORS.length).reduce((a, x) => a + x[1], 0)})</text>` : "");
    return `<div class="scatter"><svg id="gcat" xmlns="http://www.w3.org/2000/svg" width="${L + P + 210}" height="${T + P + 44}" viewBox="0 0 ${L + P + 210} ${T + P + 44}" font-family="system-ui,Arial,sans-serif" font-size="11.5" fill="#444">
      <rect x="0" y="0" width="${L + P + 210}" height="${T + P + 44}" fill="#fff"/><rect x="${L}" y="${T}" width="${P}" height="${P}" fill="#fcfcfd" stroke="#c9ced6"/>${ticks}
      <text x="${L + P / 2}" y="${T + P + 34}" text-anchor="middle" font-size="12.5" fill="#202124">G/C-site enzymes blocked (share of those tested)</text>
      <text transform="translate(14 ${T + P / 2}) rotate(-90)" text-anchor="middle" font-size="12.5" fill="#202124">A/T-site enzymes blocked</text>
      <text x="${L + P + 20}" y="${T + 8}" font-size="12" fill="#202124">Host genus</text>${legend}${dots}</svg>
      <p class="tiny">${pts.length} phage${pts.length === 1 ? "" : "s"} plotted${rows.length > pts.length ? `; ${rows.length - pts.length} not plotted because no A/T-site (or no G/C-site) enzyme was tested` : ""}. Dots are nudged slightly apart so that phages with the same values can all be seen. Lower right: G/C sites blocked, A/T sites cut. Upper left: the reverse. Hover over a dot for the phage, click to open it.</p></div>`;
  }
  function figurePatterns(M) {
    const A = S.an, F = A.f3.f, n = A.f3.size === "all" ? M.f3.length : Number(A.f3.size) || 15, shown = M.f3.slice(0, n);
    const groups = (x) => [x.g.gc ? `${x.g.gc} G/C` : "", x.g.at ? `${x.g.at} A/T` : "", x.g.both ? `${x.g.both} mixed` : ""].filter(Boolean).join(" · ");
    return `<details class="sec" data-sec="fig3"${S.open.fig3 === false ? "" : " open"}><summary><b>Figure 3:</b> patterns of blocked enzymes <span class="sub">(${M.f3.length} of ${M.f3total} pattern${M.f3total === 1 ? "" : "s"})</span></summary>
      <div class="row anbar" style="margin-left:12px"><label class="check">Show <select data-an="f3.size">${["15", "30", "60"].map((v) => selOpt(v, `first ${v}`, A.f3.size)).join("")}${selOpt("all", "all", A.f3.size)}</select></label>
      <span class="dl">Download: <button class="mini" data-adl="f3.csv">table (CSV)</button><button class="mini" data-adl="f3.png">image</button></span>
      <span class="sub">Each row is one combination of blocked enzymes and the phages that show exactly that combination. ${fmt(M.unblocked)} phage${M.unblocked === 1 ? " has" : "s have"} no blocked enzyme. A pattern also depends on which enzymes were tested.</span></div>
      <div class="tablescroll" style="margin:0 12px 10px"><table class="list an fig fig3"><thead><tr>${sortTh("f3", A.f3, "key", "Blocked enzymes")}${sortTh("f3", A.f3, "k", "Number", "c", "How many enzymes are blocked in this pattern")}<th>Site groups</th>${sortTh("f3", A.f3, "n", "Phages", "c g0")}${sortTh("f3", A.f3, "host", "Hosts (phages)")}</tr>
      <tr class="filters"><td><input data-ain="f3.f.q" value="${esc(F.q || "")}" placeholder="enzymes, e.g. BamHI SacII"></td><td><input data-ain="f3.f.minK" value="${esc(F.minK || "")}" placeholder="min" inputmode="numeric"></td><td></td><td><input data-ain="f3.f.minN" value="${esc(F.minN || "")}" placeholder="min" inputmode="numeric"></td><td><input data-ain="f3.f.host" value="${esc(F.host || "")}" placeholder="filter"></td></tr></thead><tbody>
      ${shown.map((x) => `<tr title="${esc(x.names.slice(0, 14).join(", "))}${x.names.length > 14 ? " …" : ""}"><td><b>${esc(x.key)}</b></td><td class="c">${x.k}</td><td class="sub">${groups(x)}</td><td class="c g0"><b>${x.n}</b></td><td>${esc(x.hostText)}</td></tr>`).join("") || '<tr><td colspan="5" class="sub">No pattern matches these filters.</td></tr>'}
      </tbody></table></div></details>`;
  }
  function viewAnalysis() {
    const A = S.an;
    if (!A.loaded) return '<div class="card"><h2>Analysis</h2><p class="sub">Reading the results…</p></div>';
    const M = analysisModel(), used = M.used, rows = M.rows;
    try { localStorage.setItem("rudner.analysis", JSON.stringify(anState())); } catch (err) { /* not remembered */ }
    if (!M.all.length && !A.chk) return `<div class="card"><h2>Analysis</h2><p class="sub">No digest results have been recorded yet. Open a phage, add a digest and set a result for each enzyme; the phages then appear here.</p></div>`;
    const per = A.size === "all" ? Math.max(1, rows.length) : Number(A.size) || 25, pages = Math.max(1, Math.ceil(rows.length / per));
    A.page = Math.min(Math.max(0, A.page), pages - 1);
    const shown = rows.slice(A.page * per, A.page * per + per);
    A.shownIds = shown.map((r) => r.p.phage_id);
    const pager = `<div class="row pager"><label class="check">Rows <select data-an="size">${["15", "25", "50", "100"].map((v) => selOpt(v, v, A.size)).join("")}${selOpt("all", "all", A.size)}</select></label>
      <button data-anpage="-1"${A.page ? "" : " disabled"}>◀ Previous</button><span class="sub">Page ${A.page + 1} of ${pages} · ${fmt(rows.length)} of ${fmt(M.all.length)} phages with results</span><button data-anpage="1"${A.page < pages - 1 ? "" : " disabled"}>Next ▶</button></div>`;
    const cand = M.all.filter((r) => !r.p.genome_length_bp && r.blk.length >= 3).length, nsel = A.sel.size;
    const bar = `<div class="row anbar"><label class="check">Show <select data-an="show">${selOpt("all", "all phages with results", A.show)}${selOpt("blocked", "phages with a blocked enzyme", A.show)}${selOpt("confirmed", "blocked, confirmed by genome and control", A.show)}</select></label>
      <label class="check">Blocked enzymes <select data-an="min">${selOpt("0", "any number", A.min)}${[2, 3, 4, 5, 6].map((v) => selOpt(v, `${v} or more`, A.min)).join("")}</select></label>
      <label class="check">Genome <select data-an="seq">${selOpt("", "all", A.seq)}${selOpt("yes", "sequenced", A.seq)}${selOpt("no", "not sequenced", A.seq)}</select></label>
      <label class="check">Host <select data-an="host">${selOpt("", "all", A.host)}${M.hosts.map((h) => selOpt(h, h, A.host)).join("")}</select></label>
      <label class="check">Enzyme <select data-an="enz">${selOpt("", "any", A.enz)}${used.map((z) => selOpt(z.restriction_enzyme_id, z.enzyme_name, A.enz)).join("")}</select></label>
      <label class="check" title="Count only digests whose results have been checked against the gel, or only those still to check">Digests <select data-an="chk">${selOpt("", "all", A.chk)}${selOpt("yes", "checked only", A.chk)}${selOpt("no", "not yet checked", A.chk)}</select></label>
      <label class="check">Phage or cluster <input data-ain="q" value="${esc(A.q)}" placeholder="filter"></label>
      <label class="check" title="When ticked, Figures 1 and 2 count only the phages left by these filters"><input type="checkbox" data-acheck="follow"${A.follow ? " checked" : ""}>figures follow these filters</label></div>
      <div class="row anbar"><span class="sub">${fmt(M.all.filter((r) => r.blk.length).length)} phages with a blocked enzyme · ${fmt(cand)} not sequenced with 3 or more blocked</span>
      <button class="mini" data-act="seqcand" title="Not sequenced, 3 or more blocked enzymes, most blocked first">Show sequencing candidates</button>
      ${A.qask ? `<span class="sub">Add ${nsel} phage${nsel === 1 ? "" : "s"} to the sequencing queue?</span><button class="mini" data-act="queueyes">Yes</button><button class="mini" data-act="queueno">No</button>` : `<button class="mini" data-act="queue"${nsel && !A.busy ? "" : " disabled"} title="Tick phages in the first column, then add them to the lab's sequencing queue">Queue ${nsel || ""} selected for sequencing</button>`}
      <button class="mini" data-act="recompute"${A.busy ? " disabled" : ""} title="Reads each sequenced phage's genome and fills in the virtual digest for its recorded results">Recompute virtual digests</button>
      <button class="mini" data-adl="main.csv" title="Every phage left by the filters, all pages">Download table (CSV)</button>
      <button class="mini" data-act="anlink" title="Copies an address that opens this page with the same filters and sort order, to share with a lab member">Copy link to this view</button>
      <button class="mini" data-act="anreset" title="Back to all phages, sorted by name; the filters are otherwise remembered between visits">Clear filters</button><span class="msg">${esc(A.msg || "")}</span></div>`;
    const groupHead = SITE_GROUPS.map(([g, label]) => { const n = used.filter((z) => z.grp === g).length; return n ? `<th class="c g0 grp" colspan="${n}">${label}</th>` : ""; }).join("");
    const fixed = [["name", "Phage", "nm"], ["id", "Rud Lab ID", ""], ["host", "Host", ""], ["cluster", "Cluster", ""], ["genome", "Genome", ""], ["blocked", "Blocked", "c"], ["chk", "Checked", "c"]];
    const allSel = shown.length > 0 && shown.every((r) => A.sel.has(r.p.phage_id));
    const chkCell = (r) => (!r.chk.n ? "" : r.chk.c === r.chk.n ? '<span class="ok" title="Every digest of this phage has been checked against the gel">✓</span>' : r.chk.c ? `<span class="sub">${r.chk.c}/${r.chk.n}</span>` : '<span class="sub" title="Not yet checked against the gel">–</span>');
    return `<div class="card"><h2>Analysis <span class="sub">restriction enzyme results for every phage</span></h2>${figureGroups(M)}${figureGcAt(M)}${figurePatterns(M)}${figureIslands(M)}
      <hr class="sep"><h3 id="anphages" style="margin:0 0 4px">Phages</h3>${bar}${pager}
      <div class="tablescroll tall"><table class="list an main"><thead><tr class="r1"><th class="sel" rowspan="2" title="Select every phage on this page"><input type="checkbox" data-aselall${allSel ? " checked" : ""}></th>${fixed.map((c) => sortTh("main", A, c[0], c[1], c[2], "", ' rowspan="2"')).join("")}${groupHead}</tr>
      <tr class="r2">${used.map((z, i) => sortTh("main", A, z.restriction_enzyme_id, esc(z.enzyme_name), "c" + (!i || used[i - 1].grp !== z.grp ? " g0" : ""), z.recognition_sequence || "")).join("")}</tr></thead><tbody>
      ${shown.map((r) => `<tr data-go="#/phage/${r.p.phage_id}"><td class="sel" data-nogo><input type="checkbox" data-asel="${r.p.phage_id}"${A.sel.has(r.p.phage_id) ? " checked" : ""}></td><td class="nm"><b>${esc(r.name)}</b>${A.queued.has(r.p.phage_id) ? ' <span class="chip" title="Already waiting in the sequencing queue">queued</span>' : ""}</td><td>${esc(labId(r.p))}</td><td>${esc(r.host)}</td><td>${esc(r.cluster)}</td><td>${r.p.genome_length_bp ? fmt(r.p.genome_length_bp) + " bp" : '<span class="sub">no sequence</span>'}</td><td class="c" title="${esc(r.blk.map((z) => z.enzyme_name).join(", "))}">${r.blk.length ? `<b>${r.blk.length}</b> <span class="sub">of ${r.tested}</span>` : `<span class="sub">0 of ${r.tested}</span>`}</td><td class="c">${chkCell(r)}</td>${used.map((z, i) => analysisCell(r.m.get(z.restriction_enzyme_id), !i || used[i - 1].grp !== z.grp)).join("")}</tr>`).join("") || `<tr><td colspan="${used.length + 8}" class="sub">No phage matches these filters.</td></tr>`}
      </tbody></table></div>${pager}
      <p class="tiny">✓ digests · ~ partial digestion · ✗ does not digest · ? undetermined. Enzymes are grouped by their recognition site: only G and C, only A and T, or both. <b>Blocked</b> (a bold ✗ on a coloured cell): the lab gel shows no cut although the genome has sites for the enzyme, which points to DNA modification. Red is confirmed by the genome and a control digest; amber is provisional (no genome sequence, no control digest, or the control was not confirmed). A plain grey ✗ means the genome has no sites, so no cut is expected. Each cell shows the phage's most recent digest with that enzyme. Click a heading to sort and a row to open the phage.</p></div>`;
  }
  // ---------- analysis downloads ----------
  // ---------- data quality ----------
  // How complete the digest records are. Everything here is counted from all digests, not only the latest one of each phage.
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "–");
  // One bar: parts = [[label, count, colour class, optional link]]; the counts are also written out beside it.
  function qBar(label, parts, total, unit) {
    const seg = parts.filter((x) => x[1] > 0).map((x) => `<span class="${x[2]}" style="width:${((x[1] / total) * 100).toFixed(2)}%" title="${esc(x[0])}: ${fmt(x[1])} of ${fmt(total)} (${pct(x[1], total)})"></span>`).join("");
    const text = parts.map((x) => { const t = `<i class="key ${x[2]}"></i>${esc(x[0])} <b>${fmt(x[1])}</b> <span class="sub">(${pct(x[1], total)})</span>`; return x[3] && x[1] ? `<a href="#/" data-qf="${esc(x[3])}" title="Show these phages on the Phages tab">${t}</a>` : `<span>${t}</span>`; }).join("");
    return `<div class="qrow"><div class="qlab"><b>${esc(label)}</b><br><span class="sub">${fmt(total)} ${esc(unit)}</span></div><div><div class="qbar">${total ? seg : ""}</div><div class="qtext">${text}</div></div></div>`;
  }
  function qualityModel() {
    const ex = S.an.raw.ex, rs = S.an.raw.rs, phage = new Map(S.catalog.map((p) => [p.phage_id, p]));
    const exById = new Map(ex.map((x) => [x.restriction_digest_experiment_id, x])), byPhage = new Map(), resBy = new Map();
    for (const x of ex) { if (!byPhage.has(x.phage_id)) byPhage.set(x.phage_id, []); byPhage.get(x.phage_id).push(x); }
    for (const r of rs) { if (!r.observed_result || !exById.has(r.restriction_digest_experiment_id)) continue; if (!resBy.has(r.restriction_digest_experiment_id)) resBy.set(r.restriction_digest_experiment_id, []); resBy.get(r.restriction_digest_experiment_id).push(r); }
    const seqd = (p) => !!(p && p.genome_length_bp);
    // Figure 1: phages
    const f1 = [["All phages", () => true, ""], ["Sequenced", seqd, "yes"], ["Not sequenced", (p) => !seqd(p), "no"]].map(([label, keep, g]) => {
      const o = { label, g, n: 0, checked: 0, todo: 0, none: 0 };
      for (const p of S.catalog) { if (!keep(p)) continue; o.n += 1; const d = byPhage.get(p.phage_id) || []; if (!d.length) o.none += 1; else if (d.every((x) => x.results_checked)) o.checked += 1; else o.todo += 1; }
      return o;
    });
    // Figure 2: digests
    const gelOf = new Map(); for (const list of S.digestIndex.values()) for (const x of list) gelOf.set(x.restriction_digest_experiment_id, !!(x.gel_image_path || x.gel_image_url));
    const d = { n: ex.length, chk: 0, img: 0, imgRec: 0, ctlOk: 0, ctlBad: 0, ctlNone: 0, vAll: 0, vMiss: 0, vNoSeq: 0, empty: 0 };
    for (const x of ex) {
      const p = phage.get(x.phage_id), res = resBy.get(x.restriction_digest_experiment_id) || [];
      if (x.results_checked) d.chk += 1;
      if (gelOf.get(x.restriction_digest_experiment_id)) d.img += 1; else if (p && p.restriction_digest_image_url) d.imgRec += 1;
      if (x.positive_control_passed === true) d.ctlOk += 1; else if (x.positive_control_passed === false) d.ctlBad += 1; else if (x.no_control) d.ctlNone += 1;
      if (!res.length) d.empty += 1; else if (!seqd(p)) d.vNoSeq += 1; else if (res.every((r) => virtOf(r))) d.vAll += 1; else d.vMiss += 1;
    }
    // Figure 3: results by enzyme
    const enz = new Map(), perPhage = new Map(), odd = [];
    for (const [id, res] of resBy) {
      const x = exById.get(id), p = phage.get(x.phage_id);
      for (const r of res) {
        const z = enzyme(r.restriction_enzyme_id), name = z.enzyme_name || "(enzyme no longer listed)";
        const e = enz.get(name) || { name, n: 0, "Digestion": 0, "Partial digestion": 0, "No digestion": 0, "Uninterpretable": 0 };
        e.n += 1; if (r.observed_result in e) e[r.observed_result] += 1; enz.set(name, e);
        if (!perPhage.has(x.phage_id)) perPhage.set(x.phage_id, new Set()); perPhage.get(x.phage_id).add(r.restriction_enzyme_id);
        // the gel shows cutting, but the genome has no site for this enzyme
        if (p && (r.observed_result === "Digestion" || r.observed_result === "Partial digestion") && virtOf(r) === "No digestion") odd.push({ p, x, name, obs: r.observed_result });
      }
    }
    const f3 = [...enz.values()].sort((x, y) => y.n - x.n || x.name.localeCompare(y.name));
    // Figure 4: how many enzymes each phage has a result for
    const hist = new Map(); for (const set of perPhage.values()) hist.set(set.size, (hist.get(set.size) || 0) + 1);
    const f4 = [...hist.entries()].sort((x, y) => x[0] - y[0]);
    odd.sort((x, y) => (x.p.phage_name || "").localeCompare(y.p.phage_name || "") || x.name.localeCompare(y.name));
    return { f1, d, f3, f4, odd, nres: [...resBy.values()].reduce((n, r) => n + r.length, 0), tested: perPhage.size };
  }
  function viewQuality() {
    if (!S.an.loaded) return '<div class="card"><h2>Data quality</h2><p class="sub">Reading the results…</p></div>';
    const M = qualityModel(), d = M.d, all = M.f1[0], withDigest = all.checked + all.todo;
    const sec = (key, title, sub, body) => `<details class="sec" data-sec="${key}"${S.open[key] === false ? "" : " open"}><summary><b>${title}</b> <span class="sub">${sub}</span></summary><div class="qfig">${body}</div></details>`;
    const fig1 = M.f1.map((o) => qBar(o.label, [["Checked", o.checked, "q-ok", `${o.g}|checked`], ["Digest recorded, not yet checked", o.todo, "q-warn", `${o.g}|tocheck`], ["No digest", o.none, "q-mute", `${o.g}|no`]], o.n, o.n === 1 ? "phage" : "phages")).join("");
    const unit = d.n === 1 ? "digest" : "digests";
    const fig2 = qBar("Results checked", [["Checked", d.chk, "q-ok"], ["Not yet checked", d.n - d.chk, "q-warn"]], d.n, unit)
      + qBar("Gel image", [["Uploaded with the digest", d.img, "q-ok"], ["Only the phage record's image", d.imgRec, "q-blue"], ["No image", d.n - d.img - d.imgRec, "q-mute"]], d.n, unit)
      + qBar("Control digest", [["Passed", d.ctlOk, "q-ok"], ["Failed", d.ctlBad, "q-bad"], ["No control", d.ctlNone, "q-mute"], ["Not recorded", d.n - d.ctlOk - d.ctlBad - d.ctlNone, "q-warn"]], d.n, unit)
      + qBar("Virtual digest", [["From the genome, every enzyme", d.vAll, "q-ok"], ["Missing for a sequenced phage", d.vMiss, "q-warn"], ["Phage not sequenced", d.vNoSeq, "q-mute"], ["No results entered", d.empty, "q-bad"]], d.n, unit);
    const fig3 = `<div class="tablescroll"><table class="list an qtab"><thead><tr><th>Enzyme</th><th class="c">Results</th><th style="width:45%">Share of results</th><th class="c">Digestion</th><th class="c">Partial</th><th class="c">No digestion</th><th class="c">Unclear</th><th class="c">Unclear %</th></tr></thead><tbody>
      ${M.f3.map((e) => `<tr><td><b>${esc(e.name)}</b></td><td class="c">${fmt(e.n)}</td><td><div class="qbar">${[["Digestion", "q-ok"], ["Partial digestion", "q-warn"], ["No digestion", "q-bad"], ["Uninterpretable", "q-mute"]].map((k) => (e[k[0]] ? `<span class="${k[1]}" style="width:${((e[k[0]] / e.n) * 100).toFixed(2)}%" title="${k[0]}: ${e[k[0]]} of ${e.n}"></span>` : "")).join("")}</div></td><td class="c">${e["Digestion"]}</td><td class="c">${e["Partial digestion"]}</td><td class="c">${e["No digestion"]}</td><td class="c">${e["Uninterpretable"]}</td><td class="c">${pct(e["Uninterpretable"], e.n)}</td></tr>`).join("") || '<tr><td colspan="8" class="sub">No results have been recorded yet.</td></tr>'}
      </tbody></table></div><p class="qtext"><span><i class="key q-ok"></i>Digestion</span><span><i class="key q-warn"></i>Partial digestion</span><span><i class="key q-bad"></i>No digestion</span><span><i class="key q-mute"></i>Unclear (could not be read from the gel)</span></p>`;
    const top = Math.max(1, ...M.f4.map((x) => x[1]));
    const fig4 = M.f4.map(([k, n]) => `<div class="qrow slim"><div class="qlab">${k} enzyme${k === 1 ? "" : "s"}</div><div><div class="qbar plain"><span class="q-blue" style="width:${((n / top) * 100).toFixed(2)}%"></span></div></div><div class="qnum"><b>${fmt(n)}</b> phage${n === 1 ? "" : "s"}</div></div>`).join("") || '<p class="sub">No results have been recorded yet.</p>';
    const shown = M.odd.slice(0, 50);
    const fig5 = M.odd.length ? `<div class="tablescroll"><table class="list an qtab"><thead><tr><th>Phage</th><th>Enzyme</th><th>Lab gel</th><th>Genome</th><th>Digest checked</th></tr></thead><tbody>
      ${shown.map((o) => `<tr><td><a href="#/phage/${o.p.phage_id}/digest/${o.x.restriction_digest_experiment_id}">${esc(o.p.phage_name || "")}</a></td><td>${esc(o.name)}</td><td>${esc(o.obs)}</td><td>No site</td><td>${o.x.results_checked ? "Yes" : "No"}</td></tr>`).join("")}
      </tbody></table></div>${M.odd.length > shown.length ? `<p class="sub">The first ${shown.length} of ${fmt(M.odd.length)} are shown.</p>` : ""}` : '<p class="sub">None: no gel shows cutting by an enzyme that has no site in the genome.</p>';
    return `<div class="card"><h2>Data quality</h2>
      <p class="sub">How complete the restriction digest records are. <b>${fmt(withDigest)}</b> of ${fmt(all.n)} phages (${pct(withDigest, all.n)}) have a digest; <b>${fmt(all.checked)}</b> ${all.checked === 1 ? "has" : "have"} had every digest checked. In all: ${fmt(d.n)} ${unit} and ${fmt(M.nres)} enzyme results.</p>
      ${sec("q1", "Figure 1: phages with a restriction digest", "(sequenced, not sequenced and all)", `${fig1}<p class="sub">Checked: every digest of the phage is marked as checked. Sequenced: the phage record has a genome length. Click a count to list those phages.</p>`)}
      ${sec("q2", "Figure 2: what each digest has", `(${fmt(d.n)} ${unit})`, `${fig2}<p class="sub">“Missing for a sequenced phage” can usually be filled in with <i>Recompute virtual digests</i> on the Analysis tab.</p>`)}
      ${sec("q3", "Figure 3: results by enzyme", `(${fmt(M.nres)} results)`, `${fig3}<p class="sub">An enzyme with a large share of unclear results may need repeating or a better gel.</p>`)}
      ${sec("q4", "Figure 4: enzymes tested per phage", `(${fmt(M.tested)} phage${M.tested === 1 ? "" : "s"} with results)`, fig4)}
      ${sec("q5", "Figure 5: results that disagree with the genome", `(${fmt(M.odd.length)})`, `<p class="sub">The gel shows digestion, but the genome has no site for the enzyme. These are worth a second look: the wrong lane, the wrong phage, or a genome that does not match the sample.</p>${fig5}`)}
    </div>`;
  }
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const saveCsv = (rows, name) => saveBlob(new Blob(["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }), name);
  // Draws a table as it looks on the page (without its filter row) onto a canvas.
  function tableToCanvas(tbl, title) {
    const R = tbl.getBoundingClientRect(), k = 2, pad = title ? 30 : 0, fr = tbl.querySelector("tr.filters"), fb = fr ? fr.getBoundingClientRect() : null, cut = fb ? fb.height : 0;
    const c = document.createElement("canvas"); c.width = Math.ceil(R.width * k); c.height = Math.ceil((R.height - cut + pad) * k);
    const g = c.getContext("2d"); g.scale(k, k); g.fillStyle = "#fff"; g.fillRect(0, 0, R.width, R.height + pad);
    if (title) { g.fillStyle = "#202124"; g.font = "600 14px system-ui,Arial,sans-serif"; g.textBaseline = "middle"; g.textAlign = "left"; g.fillText(title, 8, 15); }
    for (const cell of tbl.querySelectorAll("th,td")) {
      if (cell.closest("tr.filters")) continue;
      const b = cell.getBoundingClientRect(), cs = getComputedStyle(cell), x = b.left - R.left, y = b.top - R.top + pad - (fb && b.top >= fb.bottom - 1 ? cut : 0);
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") { g.fillStyle = cs.backgroundColor; g.fillRect(x, y, b.width, b.height); }
      g.strokeStyle = "#e3e6ea"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y + b.height); g.lineTo(x + b.width, y + b.height); g.stroke();
      const center = cs.textAlign === "center", bold = cell.tagName === "TH" || cell.querySelector("b") ? 600 : 400;
      g.fillStyle = cs.color; g.font = `${bold} ${cs.fontSize} system-ui,Arial,sans-serif`; g.textAlign = center ? "center" : "left"; g.textBaseline = "middle";
      g.fillText(cell.innerText.replace(/[▲▼]/g, "").replace(/\s+/g, " ").trim(), center ? x + b.width / 2 : x + (parseFloat(cs.paddingLeft) || 6), y + b.height / 2);
    }
    return c;
  }
  function analysisDownload(what) {
    const A = S.an, M = analysisModel(), day = new Date().toISOString().slice(0, 10), bn = (x) => (x.n ? `${x.b} of ${x.n}` : "");
    if (what === "main.csv") return saveCsv([["Phage", "Rud Lab ID", "Host", "Cluster", "Subcluster", "Genome bp", "Blocked enzymes", "Enzymes tested", "Blocked", "Digests checked", "Likely modified", "Evidence", ...M.used.map((z) => z.enzyme_name)],
      ...M.rows.map((r) => [r.name, labId(r.p), r.host, r.p.phagesdb_cluster || "", r.p.phagesdb_subcluster || "", r.p.genome_length_bp || "", r.blk.length, r.tested, r.blk.map((z) => z.enzyme_name).join("; "), `${r.chk.c} of ${r.chk.n}`, r.call, r.ev, ...M.used.map((z) => { const c = r.m.get(z.restriction_enzyme_id); return c ? (c.blocked ? "Blocked" : c.obs) : ""; })])], `phage_digest_analysis_${day}.csv`);
    if (what === "f1.csv") return saveCsv([[A.fig, "Phages", "Phages with 3+ blocked", ...M.used.map((z) => `${z.enzyme_name} blocked of tested`)], ...M.f1.map((x) => [x.g, x.n, x.ge3, ...M.used.map((z) => bn(x.cells.get(z.restriction_enzyme_id)))])], `blocked_by_${A.fig}_${day}.csv`);
    if (what === "f2.csv") return saveCsv([["Phage", "Rud Lab ID", "Host", "Cluster", "Genome bp", "G/C-site enzymes blocked of tested", "A/T-site enzymes blocked of tested", "Mixed-site enzymes blocked of tested", "Likely modified", "Evidence"],
      ...M.f2.map((r) => [r.name, labId(r.p), r.host, r.cluster, r.p.genome_length_bp || "", bn(r.gc), bn(r.at), bn(r.both), r.call, r.ev])], `gc_at_modification_${day}.csv`);
    if (what === "f3.csv") return saveCsv([["Blocked enzymes", "Number blocked", "G/C-site", "A/T-site", "Mixed-site", "Phages", "Hosts (phages)", "Phage names"], ...M.f3.map((x) => [x.key, x.k, x.g.gc, x.g.at, x.g.both, x.n, x.hostText, x.names.join("; ")])], `blocked_enzyme_patterns_${day}.csv`);
    if (what === "f4.csv") return saveCsv([["Phage", "Rud Lab ID", "Host", "Cluster", "Annotation", "Type", "Evidence", "Marker genes", "Start bp", "End bp", "Modification genes", "Pathways", "Bases", "Predicted", "Digest call", "Digest comparison"],
      ...M.f4.map((x) => [x.name, labId(x.p), x.host, x.cluster, x.src, x.kind, x.strength, x.hits.length, x.lo, x.hi, x.hits.map(hitLabel).join("; "), [...new Set(x.hits.map((h) => h.m.path))].join("; "), x.bases.join(", "), x.cls, x.call, x.match])], `dna_modification_islands_${day}.csv`);
    if (what === "f2s.png") {
      const svg = app.querySelector("#gcat");
      if (!svg) { A.msg = "Open Figure 2 first, then download its plot."; render(); return; }
      return svgToCanvas(new XMLSerializer().serializeToString(svg), 2).then((c) => c.toBlob((b) => b && saveBlob(b, `gc_at_plot_${day}.png`), "image/png"));
    }
    const pick = { "f1.png": ["table.fig1", `Blocked enzymes by ${A.fig} (phages blocked / tested) · ${day}`, `blocked_by_${A.fig}_${day}.png`], "f2.png": ["table.fig2", `Phages most likely G/C or A/T modified · ${day}`, `gc_at_modification_${day}.png`], "f3.png": ["table.fig3", `Patterns of blocked enzymes · ${day}`, `blocked_enzyme_patterns_${day}.png`], "f4.png": ["table.fig4", `DNA modification gene islands · ${day}`, `dna_modification_islands_${day}.png`] }[what];
    const tbl = pick && app.querySelector(pick[0]);
    if (!tbl) { A.msg = "Open the figure first, then download its image."; render(); return; }
    tableToCanvas(tbl, pick[1]).toBlob((b) => b && saveBlob(b, pick[2]), "image/png");
  }
  // One card per digest image: the picture already on the phage record first, then each uploaded replicate gel.
  // Each card lists the results recorded for that image, with the Edit button in the first column.
  const ownGel = (x) => publicUrl(x.gel_image_path) || x.gel_image_url || "";
  function imageCards() {
    const p = S.phage, base = phageGel();
    const byDate = S.digests.slice().sort((x, y) => String(x.experiment_date || "9999").localeCompare(String(y.experiment_date || "9999")) || String(x.created_at || "").localeCompare(String(y.created_at || "")));
    const shared = byDate.filter((x) => !ownGel(x)), cards = [];
    if (base || shared.length || !byDate.length) cards.push({ img: base, title: base ? `from ${srcName(base)}` : "no image yet", exps: shared, canAdd: true });
    for (const x of byDate.filter(ownGel)) cards.push({ img: ownGel(x), title: "uploaded replicate", exps: [x] });
    const yes = chip("done", "ok"), no = chip("to do", "mute");
    const line = (x) => {
      const st = stageOf(x, S.results); st.lab = st.lab || !!phageGel();
      const rs = S.results.filter((r) => r.restriction_digest_experiment_id === x.restriction_digest_experiment_id);
      const lanes = (Array.isArray(x.lane_layout) ? x.lane_layout : []).map((t) => (t === "L" ? "ladder" : t === "U" ? "uncut" : enzyme(t).enzyme_name || "?"));
      const started = lanes.some((t) => t !== "ladder" && t !== "uncut") || rs.length > 0;
      const blk = rs.filter((r) => r.observed_result === "No digestion" && virtOf(r) !== "No digestion").map((r) => enzyme(r.restriction_enzyme_id).enzyme_name);
      return `<tr><td><a class="btn${started ? "" : " primary"}" href="#/phage/${p.phage_id}/digest/${x.restriction_digest_experiment_id}">${started ? "Edit" : "Add digest result"}</a></td><td>${esc(x.experiment_date || "no date")}</td><td>${esc(lanes.join(" · ") || rs.map((r) => enzyme(r.restriction_enzyme_id).enzyme_name).join(" · "))}</td><td>${st.planned ? yes : no}</td><td>${st.lab ? yes : no}</td><td>${st.compared ? yes : no}</td><td>${blk.length ? chip(blk.join(", "), x.positive_control_passed === true ? "bad" : "warn") + (x.positive_control_passed === true ? "" : ` <span class="sub">${x.no_control ? "no control" : "control not passed"}</span>`) : ""}</td><td>${x.results_checked ? chip("checked", "ok") : chip("to check", "mute")}</td></tr>`;
    };
    return cards.map((c, i) => `<div class="imgbox"><div class="row"><b>Digest image ${i + 1}</b> <span class="sub">${esc(c.title)}</span></div>
        ${c.exps.length ? `<div class="tablescroll"><table class="list dres"><thead><tr><th></th><th>Date</th><th>Lanes</th><th>Plan</th><th>Lab gel</th><th>Compared</th><th>Blocked</th><th>Checked</th></tr></thead><tbody>${c.exps.map(line).join("")}</tbody></table></div>` : c.canAdd ? `<div class="row res"><a class="btn primary" href="#/phage/${p.phage_id}/digest/new">Add digest result</a><span class="sub">No digest results recorded for this image yet.</span></div>` : ""}
        ${c.img ? `<a href="${esc(c.img)}" target="_blank" rel="noopener"><img src="${esc(c.img)}" alt="Restriction digest"></a>` : '<div class="empty">No digest image yet. Add one with the button above, or record a result without an image.</div>'}</div>`).join("");
  }
  // A replicate starts as a digest that holds only its gel image; the enzymes and results are added from its card.
  async function addReplicateImage(file) {
    const id = uuid();
    S.busy = "Preparing the image…"; S.msg = ""; render();
    try {
      const r = await resizeImage(file), path = `${S.phage.phage_id}/${id}/gel-${Date.now()}.jpg`;
      S.busy = `Uploading (${Math.round(r.blob.size / 1024)} KB)…`; render();
      const up = await sb.storage.from(CFG.IMAGE_BUCKET).upload(path, r.blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const ins = await sb.from("restriction_digest_experiments").insert({ restriction_digest_experiment_id: id, phage_id: S.phage.phage_id, gel_image_path: path, lane_layout: [] });
      if (ins.error) throw ins.error;
      await loadBase(); await loadPhage(S.phage.phage_id);
      S.msg = `Digest image added.${pdfNote(r)} Use Add digest result on its card to record the enzymes and results.`;
    } catch (err) { S.msg = `Image not added: ${err.message || err}`; }
    S.busy = ""; render();
  }
  // One line that sums up what the digests of this phage say.
  function phageSummary() {
    const p = S.phage, m = latestByPhage(S.digests, S.results).get(p.phage_id);
    const isl = S.pisl ? `<br><span class="sub">Modification genes in the annotated genome:</span> ${S.pisl.islands.length ? S.pisl.islands.map((x) => `${esc(x.kind.toLowerCase())} at ${fmt(x.lo)}–${fmt(x.hi)} bp (${esc(x.hits.map((h) => h.m.name).join(", "))}${x.cls === "Not stated" ? "" : `; predicted ${esc(x.cls)}`})`).join("; ") : '<span class="sub">none recognised</span>'}` : "";
    if (!m) return isl ? `<div class="note psum"><b>Summary.</b> No digest results yet.${isl}</div>` : "";
    const used = usedEnzymes([m]), r = phageRow(p, m, used, { n: S.digests.length, c: S.digests.filter((x) => x.results_checked).length });
    const sens = r.blk.filter((z) => z.modification_sensitivity).map((z) => `${z.enzyme_name}: ${z.modification_sensitivity}`);
    return `<div class="note psum"><b>Summary.</b> ${r.blk.length ? `Blocked: ${r.blk.map((z) => esc(z.enzyme_name)).join(", ")} <span class="sub">(${r.blk.length} of ${r.tested} enzymes tested)</span>` : `No blocked enzyme <span class="sub">(${r.tested} tested)</span>`}
      · Likely modified: ${r.call === "G/C" || r.call === "A/T" || r.call === "G/C and A/T" ? chip(r.call, "warn") : esc(r.call.toLowerCase())}${r.ev ? ` <span class="sub">(${esc(r.ev.toLowerCase())})</span>` : ""}
      · Checked: ${r.chk.c} of ${r.chk.n} digest${r.chk.n === 1 ? "" : "s"}${isl}${sens.length ? `<br><span class="sub">Known sensitivity of the blocked enzymes: ${esc(sens.join("; "))}</span>` : ""}</div>`;
  }
  function viewPhage() {
    const p = S.phage;
    return `<p><a href="#/">← All phages</a></p>
      <div class="card"><div class="row phead"><h2>${esc(p.phage_name)} <span class="sub">ID ${esc(labId(p))}</span></h2>
        <span class="sub">${esc(hostOf(p))}${p.phagesdb_cluster ? " · Cluster " + esc(p.phagesdb_subcluster || p.phagesdb_cluster) : ""}${p.genome_length_bp ? " · " + fmt(p.genome_length_bp) + " bp" : " · no genome sequence yet"}</span></div>
      <div class="row"><label class="btn">+ Add a digest image (replicate experiment)<input type="file" accept="image/*,application/pdf,.pdf" data-replicate hidden></label><span class="msg">${esc(S.busy || S.msg)}</span></div>
      ${phageSummary()}
      ${imageCards()}
      </div>`;
  }

  // ---------- the two panels of a digest: the phage's own DNA, and the control DNA ----------
  // K("digest") and K("control") answer the same questions for each, so the page is drawn by the same code.
  function K(kind) {
    const D = S.D, ctl = kind === "control";
    const seq = ctl ? (S.control && S.control.seq) || "" : (S.genome && S.genome.seq) || "";
    const circ = ctl ? false : !!(S.genome && S.genome.circular);
    const cuts = (id) => (seq ? DG.digest(seq, enzyme(id).recognition_sequence, circ) : null);
    const vcall = ctl ? (id) => { const c = cuts(id); return c ? (c.sites > 0 ? "Digestion" : "No digestion") : ""; } : virtualCall;
    const ownImg = ctl ? publicUrl(D.controlPath) : publicUrl(D.gelPath) || D.legacyGelUrl;
    return {
      ctl, seq, cuts, vcall, ownImg, img: ownImg || (ctl ? "" : phageGel()),
      get: (L) => (ctl ? D.controlCalls[L.id] || "" : L.observed || ""),
      set: (L, v) => { if (ctl) D.controlCalls[L.id] = v; else L.observed = v; },
      dnaName: ctl ? (S.control && S.control.name) || D.controlName || "Lambda DNA" : S.phage.phage_name,
      title: ctl ? "Control digest" : "Lab digest"
    };
  }
  function gelLanes(kind) {
    const D = S.D, k = K(kind);
    const lanes = D.lanes.map((L) => (L.sp === "ladder" ? { label: "Ladder", kind: "ladder" } : L.sp === "uncut" ? { label: "Uncut", kind: "bands", fragments: [k.seq.length] } : { label: laneName(L), kind: "bands", fragments: k.cuts(L.id).fragments }));
    if (!D.lanes.some((L) => L.sp === "ladder")) lanes.unshift({ label: "Ladder", kind: "ladder" });
    return lanes;
  }
  function virtualGel(kind) {
    const D = S.D, k = K(kind || "digest");
    if (!k.seq) return "";
    if (!D.lanes.length) return '<p class="sub">The predicted bands appear here once a lane is added.</p>';
    return `<div class="gelscroll" style="padding-top:${GEL_OPT.wells}px">${DG.gelSvg(gelLanes(kind || "digest"), gelOpt())}</div>${D.lanes.some((L) => L.sp === "ladder") ? "" : '<p class="tiny">A 1 kb ladder is drawn first for scale; it is not one of your lanes.</p>'}`;
  }
  function genomeBox() {
    const g = S.genome;
    const upl = S.role === "owner" || S.role === "editor" ? ` <label class="btn mini" title="Keeps the lab's own genome file for this phage where the site can read it (lab members only). It replaces any file uploaded before.">Upload a genome FASTA<input type="file" accept=".fasta,.fa,.fna,.fas,.txt" data-genomeup hidden></label>` : "";
    if (!g || g.loading) return '<p class="sub">Reading the genome…</p>';
    if (g.error) return `<div class="note warn"><b>No virtual digest yet.</b> ${esc(g.error)} You can still record the lab digest now and come back when the sequence is available.${upl}</div>`;
    return `<p class="sub">Genome: ${esc(g.label)} · ${fmt(g.seq.length)} bp · ${g.circular ? "circular" : "linear"}.${upl}${S.genes ? (S.genes.n ? (S.genes.hits.length ? ` <span class="chip warn">DNA-modification genes annotated: ${esc(S.genes.hits.join(", "))}</span>` : " No DNA-modification genes found in the annotation.") : " The genome is not annotated yet, so modification genes can't be checked.") : ""}</p>`;
  }
  function imageBox(kind, title, path, legacy) {
    const own = publicUrl(path), url = own || legacy || "";
    const from = !own && url ? `<p class="tiny">Showing the image from ${srcName(url)}. Upload one only if this digest has its own gel.</p>` : "";
    return `<div class="imgbox"><div class="row"><b>${title}</b><label class="btn">${url ? "Replace image" : "Upload image"}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" data-upload="${kind}" hidden></label></div>
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${title}"></a>${from}` : '<div class="empty">No image yet. JPEG or PNG; it is resized before upload.</div>'}</div>`;
  }

  // Where the enzyme cuts, written like G^AATTC (the catalogue stores it with ^ or /).
  const cutSite = (z) => String(z.cut_description || "").trim().replace("/", "^") || z.recognition_sequence || "";
  // The picker: lane order on top, then a grid of tick-boxes with Ladder and Uncut first and the chosen enzymes next.
  function enzymePicker() {
    const D = S.D, g = S.genome && S.genome.seq, last = D.lanes.length - 1;
    const box = (attr, on, label, title, lock) => `<label class="pick${on ? " on" : ""}" title="${esc(title || "")}"><input type="checkbox" ${attr}${on ? " checked" : ""}${lock ? " disabled" : ""}><span>${label}</span></label>`;
    const list = S.enzymes.map((z) => ({ z, on: D.lanes.some((L) => L.id === z.restriction_enzyme_id) })).sort((a, b) => a.z.enzyme_name.localeCompare(b.z.enzyme_name));   // always by name, so ticking or unticking an enzyme never moves it
    const enz = list.map(({ z, on }) => {
      const c = g ? DG.digest(S.genome.seq, z.recognition_sequence, S.genome.circular) : null;
      const lock = D.saved.has(z.restriction_enzyme_id) && S.role !== "owner";
      const tip = `${c ? (c.sites ? `${c.sites} cut${c.sites === 1 ? "" : "s"} in this genome · fragments: ${c.fragments.slice(0, 8).map(fmt).join(", ")}${c.fragments.length > 8 ? " …" : ""} bp` : "No sites in this genome") : "Cuts are counted once the genome sequence is available"}${lock ? " · has a saved result" : ""}`;
      return box(`data-pick="${z.restriction_enzyme_id}"`, on, `<b>${esc(z.enzyme_name)}</b> <span class="mono">${esc(cutSite(z))}</span>${c ? ` <span class="n">(${c.sites})</span>` : ""}`, tip, lock);
    }).join("");
    const order = D.lanes.length ? `<div class="order"><span class="sub">Lane order:</span>${D.lanes.map((L, i) => `<span class="ord${L.sp ? " sp" : ""}"><button class="mini" data-move="${i}" data-dir="-1"${i ? "" : " disabled"} title="Move one lane to the left on the gel">◀</button><b>${esc(laneName(L))}</b><button class="mini" data-move="${i}" data-dir="1"${i < last ? "" : " disabled"} title="Move one lane to the right on the gel">▶</button></span>`).join("")}<button class="mini" data-add="ladder" title="Add another ladder lane at the end">+ ladder</button></div>` : "";
    const owner = S.role === "owner";
    const presets = `<div class="presets"><span class="sub">Presets:</span>${S.presets.length ? S.presets.map((P) => { const id = P.restriction_enzyme_preset_id; return `<span class="ord"><button class="mini" data-preset="${id}" title="Use these lanes: ${esc(presetLabel(P))}">${esc(P.preset_name)}</button>${owner ? (S.presetDel === id ? `<span class="sub">Delete?</span><button class="mini" data-presetdel="${id}" data-yes="1">Yes</button><button class="mini" data-presetdel="">No</button>` : `<button class="mini" data-presetdel="${id}" title="Delete this preset (owners only)">✕</button>`) : ""}</span>`; }).join("") : '<span class="sub">none saved yet</span>'}
      <span class="presetnew"><input type="text" data-presetname data-f="presetName" maxlength="60" placeholder="Preset name, e.g. High GC" value="${esc(D.presetName || "")}"><button class="mini" data-act="presetsave" title="Save the lanes chosen below, in this order, under this name. An existing preset with the same name is replaced.">Save these lanes as a preset</button></span></div>`;
    return `${presets}${order}<div class="picks">${box('data-sp="ladder"', D.lanes.some((L) => L.sp === "ladder"), "<b>Ladder</b>", "A ladder lane; it goes in lane 1")}${box('data-sp="uncut"', D.lanes.some((L) => L.sp === "uncut"), "<b>Uncut</b>", "A lane of uncut DNA")}${enz}</div>
      <p class="tiny">^ marks where the enzyme cuts${g ? "; the number in brackets is how many times it cuts this genome" : ""}. <a href="#/enzymes" target="_blank" rel="noopener">Enzyme details</a></p>`;
  }
  const CALL_BTN = [["Digestion", "✓", "ok", "Digests: the lab gel shows the enzyme cut the DNA"], ["Partial digestion", "~", "warn", "Partial digestion: some DNA cut, some left uncut"], ["No digestion", "✗", "bad", "Does not digest: the DNA is uncut in the lab gel"], ["Uninterpretable", "?", "mute", "Undetermined: the lane cannot be read"]];
  // One column per enzyme (ladder and uncut lanes have no result): the lab row is clicked, the virtual row is predicted.
  function laneStrip(kind) {
    const D = S.D, k = K(kind), cols = D.lanes.map((L, i) => ({ L, i })).filter((x) => !x.L.sp);
    if (!cols.length) return '<div class="note warn">No enzymes chosen yet. Open <b>Enzymes and lane order</b> above to choose them.</div>';
    const blk = (L) => !k.ctl && isBlocked(L);
    const head = cols.map(({ L, i }, n) => `<th class="${blk(L) ? "blk" : ""}${i === S.cur ? " cur" : ""}" title="${esc(cutSite(enzyme(L.id)))}"><span class="ln">lane ${i + 1}</span><span class="mv"><button class="mini" data-emove="${i}" data-dir="-1"${n ? "" : " disabled"} title="Move this enzyme one place to the left; its result moves with it">◀</button>${esc(laneName(L))}<button class="mini" data-emove="${i}" data-dir="1"${n < cols.length - 1 ? "" : " disabled"} title="Move this enzyme one place to the right; its result moves with it">▶</button>${D.saved.has(L.id) && S.role !== "owner" ? '<button class="mini rm" disabled title="This enzyme has a saved result; only an owner can remove it">✕</button>' : `<button class="mini rm" data-drop="${i}" title="Remove ${esc(laneName(L))} from this digest. Nothing is deleted until you save.">✕</button>`}</span></th>`).join("");
    const lab = cols.map(({ L, i }) => { const o = k.get(L); return `<td class="${blk(L) ? "blk" : ""}${i === S.cur ? " cur" : ""}"><div class="cb">${CALL_BTN.map((b) => `<button class="call ${o === b[0] ? "on " + b[2] : o ? "" : "unset"}" data-call="${i}" data-val="${b[0]}" title="${b[3]}" aria-label="${b[0]}">${b[1]}</button>`).join("")}</div></td>`; }).join("");
    const virt = cols.map(({ L }) => { const c = k.cuts(L.id), v = k.vcall(L.id); return `<td class="${blk(L) ? "blk" : ""}" title="${c ? (c.sites ? `Fragments: ${c.fragments.slice(0, 8).map(fmt).join(", ")}${c.fragments.length > 8 ? " …" : ""} bp` : "No recognition sites in this DNA, so this lane should stay uncut") : "No sequence yet"}">${!v ? '<span class="sub">—</span>' : v === "Digestion" ? `<span class="t-ok">✓</span> ${c ? `${c.sites} cut${c.sites === 1 ? "" : "s"}` : "digests"}` : `<span class="t-bad">✗</span> ${c ? "0 cuts" : "no digestion"}`}</td>`; }).join("");
    const verdict = cols.map(({ L }) => { const v = k.vcall(L.id), o = k.get(L); return `<td class="${blk(L) ? "blk" : ""}">${!o ? '<span class="t-warn">not set</span>' : !v ? "" : blk(L) ? '<b class="t-bad">blocked</b>' : v === o ? '<span class="t-ok">as predicted</span>' : o === "Partial digestion" ? '<span class="t-warn">partial</span>' : o === "Uninterpretable" ? '<span class="sub">unclear</span>' : '<span class="t-warn">differs</span>'}</td>`; }).join("");
    return `<div class="tablescroll"><table class="results"><thead><tr><th></th>${head}</tr></thead><tbody>
      <tr><th>${k.ctl ? "Control digest" : "Lab digest"}</th>${lab}</tr><tr><th>Virtual digest</th>${virt}</tr><tr class="cmp"><th></th>${verdict}</tr></tbody></table></div>
      <p class="tiny">Keyboard: ← → choose an enzyme (outlined), then 1 digests · 2 partial · 3 does not digest · 4 undetermined. The choice moves on to the next enzyme.</p>`;
  }
  // The gel pair: the lab image on the left, the virtual digest on the right, with a guide line that can be dragged across both.
  // The tools, then `above` (the result rows), then the lab and virtual images side by side.
  function gelPair(kind, above) {
    const D = S.D, k = K(kind);
    const from = k.img && !k.ownImg ? ` <span class="sub">from ${srcName(k.img)}</span>` : "";
    const empty = k.ctl ? "No control digest image yet. Use <b>Add a control digest image</b> above (JPEG, PNG or PDF)." : "No lab digest image yet. Use <b>Add a lab digest image</b> above (JPEG, PNG or PDF).";
    const noSeq = k.ctl ? (S.control && S.control.error) || "Loading the control sequence…" : S.genome && S.genome.loading ? "Reading the genome…" : "No genome sequence yet, so no virtual digest. Results can still be recorded now and compared later.";
    return `<div class="row tools">
        <span class="gelopt"><label class="check">Ladder <select data-f="ladder" data-redraw><option value="">generic 1 kb</option>${CFG.LADDERS.concat(D.ladder && !CFG.LADDERS.includes(D.ladder) ? [D.ladder] : []).map((l) => `<option${l === D.ladder ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label></span>
        <span class="gelopt">Virtual digest: <label class="check" title="Moves the virtual digest down so its wells sit level with the wells in the lab image">wells <input type="range" min="0" max="400" step="2" value="${GEL_OPT.wells}" data-gelnum="wells"><output>${GEL_OPT.wells}px</output></label>
          <label class="check">height <input type="range" min="180" max="800" step="10" value="${GEL_OPT.height}" data-gelnum="height"><output>${GEL_OPT.height}px</output></label>
          <label class="check" title="A longer run moves the bands further down the gel; small fragments run off the end">run time <input type="range" min="40" max="250" step="5" value="${Math.round(GEL_OPT.run * 100)}" data-gelnum="run"><output>${Math.round(GEL_OPT.run * 100)}%</output></label></span>
        ${gelOptBar()}
        <label class="check"><input type="checkbox" data-guide${S.guide.on ? " checked" : ""}>guide line</label>
        <span class="dl">Download: <button class="mini" data-dl="lab"${k.img ? "" : " disabled"}>${k.ctl ? "control" : "lab"} digest</button><button class="mini" data-dl="virtual"${k.seq && D.lanes.length ? "" : " disabled"}>virtual digest</button><button class="mini" data-dl="both"${k.img && k.seq && D.lanes.length ? "" : " disabled"}>both together</button></span>
      </div>
      ${above || ""}
      <div class="two gels" id="gels">
        ${S.guide.on ? `<div class="guide" id="guide" style="top:${S.guide.y}px" title="Drag up or down to compare band positions"><span>drag</span></div>` : ""}
        <div><b>${k.title}</b>${from} <label class="btn mini" title="JPEG, PNG or PDF. A PDF's first page is turned into an image.">${k.ownImg ? "Replace image" : k.ctl ? "Add a control digest image" : "Add a lab digest image"}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" data-upload="${k.ctl ? "control" : "gel"}" hidden></label>${k.img ? ` <span class="zoomctl"><button class="mini" data-zoom="-1"${S.zoom.k > 1 ? "" : " disabled"} title="Zoom out">−</button><span class="sub">${Math.round(S.zoom.k * 100)}%</span><button class="mini" data-zoom="1"${S.zoom.k < 5 ? "" : " disabled"} title="Zoom in; then drag the image to move it">+</button><button class="mini" data-zoom="0"${S.zoom.k > 1 ? "" : " disabled"}>reset</button></span>
          <div class="zoomwrap${S.zoom.k > 1 ? " zoomed" : ""}"><img class="big" src="${esc(k.img)}" alt="${k.title}" draggable="false" style="transform:translate(${S.zoom.x}px,${S.zoom.y}px) scale(${S.zoom.k})"></div>` : `<div class="empty">${empty}</div>`}
          ${k.img ? `<p class="tiny"><a href="${esc(k.img)}" target="_blank" rel="noopener">Open the image</a>${!k.ctl && D.gelOriginal ? ` · <a href="${esc(D.gelOriginal)}" target="_blank" rel="noopener">full-size original</a> (lab members only)` : ""}${k.ctl && D.controlOriginal ? ` · <a href="${esc(D.controlOriginal)}" target="_blank" rel="noopener">full-size original</a> (lab members only)` : ""}</p>` : ""}</div>
        <div><b>Virtual digest</b> <span class="sub">${esc(k.dnaName)}, from the DNA sequence, same lane order</span><div id="vgel">${k.seq ? virtualGel(kind) : `<div class="empty">${esc(noSeq)}</div>`}</div></div>
      </div>`;
  }
  function gelDetails() {
    const D = S.D;
    return `<div class="row fields">
        <label>Date of the digest<input type="date" data-f="date" value="${esc(D.date)}"></label>
      </div>
      ${imageBox("gel", "Lab digest image", D.gelPath, D.legacyGelUrl || phageGel())}
      <label class="full">Link to the full-size original (SharePoint / OneDrive) <span class="sub">— lab members only</span><input type="url" data-f="gelOriginal" value="${esc(D.gelOriginal)}" placeholder="https://…"></label>`;
  }
  function controlDetails() {
    const D = S.D, c = S.control;
    return `${imageBox("control", "Control digest image", D.controlPath, "")}
      <label class="full">Link to the full-size original of the control <span class="sub">— lab members only</span><input type="url" data-f="controlOriginal" value="${esc(D.controlOriginal)}" placeholder="https://…"></label>
      <div class="row fields"><label>Control DNA<input data-f="controlName" value="${esc(D.controlName)}"></label>
        <span class="sub">${c && c.seq ? `Sequence in use: ${esc(c.name)} (${fmt(c.seq.length)} bp)` : ""}</span>
        <label class="btn">Use a different control sequence (FASTA file)<input type="file" accept=".fasta,.fa,.fna,.txt" data-controlfasta hidden></label></div>`;
  }
  function viewDigest() {
    const D = S.D, p = S.phage, ctl = S.tab === "control", k = K(S.tab);
    const enz = D.lanes.filter((L) => !L.sp), unset = enz.filter((L) => !L.observed).length, cunset = enz.filter((L) => !D.controlCalls[L.id]).length;
    const openEnz = S.open.enz == null ? !D.lanes.length : S.open.enz, openGel = !!S.open.gel, openCtl = !!S.open.ctl;
    const anyBlocked = D.lanes.some(isBlocked);
    const hasControl = !!D.controlPath || Object.keys(D.controlCalls).length > 0;
    const tab = (t, label, mark) => `<button class="tab ${S.tab === t ? "on" : ""}" data-tab="${t}">${label}${mark ? ` <span class="sub">${mark}</span>` : ""}</button>`;
    return `<p><a href="#/phage/${p.phage_id}">← ${esc(p.phage_name)}</a></p>
      <div class="card"><h2>${D.isNew ? "New digest" : "Digest"} · ${esc(p.phage_name)} <span class="sub">${esc(D.date || "")}</span> <span class="sub prog" title="Digests whose results have been checked against the gel, out of all digests in the database">${(() => { const a = [...S.digestIndex.values()].flat(); return a.length ? `· ${a.filter((x) => x.results_checked).length} of ${a.length} digests checked` : ""; })()}</span></h2>
      ${genomeBox()}
      <details class="sec" data-sec="enz"${openEnz ? " open" : ""}><summary><b>Enzymes and lane order:</b> ${D.lanes.length ? `${esc(D.lanes.map(laneName).join(", "))} <span class="sub">(change)</span>` : '<span class="sub">tick the lanes on the gel and put them in order</span>'}</summary>${enzymePicker()}</details>
      <div class="tabs">${tab("digest", "Digest", enz.length ? (unset ? `${enz.length - unset}/${enz.length}` : "✓") : "")}${tab("control", "Control", hasControl ? (cunset ? `${enz.length - cunset}/${enz.length}` : "✓") : "optional")}</div>
      ${ctl ? `<p class="sub">The control uses the same enzymes and lane order as the digest. It shows whether the enzymes and conditions worked, using a DNA known to cut (${esc(k.dnaName)}).</p>` : ""}
      ${gelPair(S.tab, `<h4>${ctl ? "Control result for each enzyme" : "Result for each enzyme"}${ctl && enz.length ? ' <button class="mini" data-act="ctlall" title="The expected result: every enzyme cuts the control DNA">Set all to ✓ digests</button> <button class="mini" data-act="ctlclear">Clear all</button>' : ""}</h4>
      ${laneStrip(S.tab)}
      ${!ctl && anyBlocked && D.control !== true ? `<div class="note bad">A lane is <b>blocked</b> (${S.genome && S.genome.seq ? "the genome has sites but the gel shows no cut" : "the gel shows no cut; with no genome sequence it is presumed blocked"}). ${D.control === "none" ? "No control was run, so the blocked result stays provisional: there is no proof the enzyme was working." : "Blocked results are only counted when the control digested as expected: answer that beside Save."}</div>` : ""}`)}
      ${ctl
        ? `<details class="sec" data-sec="ctl"${openCtl ? " open" : ""}><summary><b>Control image and control DNA</b> <span class="sub">${[D.controlPath ? "control image added" : "no control image", esc(k.dnaName)].join(" · ")}</span></summary>${controlDetails()}</details>`
        : `<details class="sec" data-sec="gel"${openGel ? " open" : ""}><summary><b>Gel image and date</b> <span class="sub">${[D.date || "no date", k.ownImg ? "own gel image" : k.img ? `gel from ${srcName(k.img)}` : "no gel image"].join(" · ")}</span></summary>${gelDetails()}</details>`}
      <div class="savebar"><label class="check" title="Tick once the results above have been checked against the gel image"><input type="checkbox" data-chk${D.checked ? " checked" : ""}>Results checked against the gel</label>
        <span>Did the control digest as expected? <span class="seg">${[["true", "Yes"], ["false", "No"], ["none", "No control"]].map((o) => `<button data-control="${o[0]}" class="${String(D.control) === o[0] ? "on" : ""}">${o[1]}</button>`).join("")}</span></span>
        <button class="primary" data-act="save"${S.busy ? " disabled" : ""}>Save</button>
        <button data-act="savenext"${S.busy ? " disabled" : ""} title="Ticks 'Results checked', saves, and opens the next digest that still needs checking">Checked: save and next ▶</button>
        <button data-act="cancel"${S.busy ? " disabled" : ""} title="Leaves this digest without saving; anything changed since the last save is dropped">Cancel</button>
        ${S.role === "owner" && !D.isNew ? (D.delAsk ? `<span class="t-bad">Delete this digest and all its results?</span><button data-act="delyes"${S.busy ? " disabled" : ""}>Yes, delete</button><button data-act="delno">No</button>` : '<button data-act="del" title="Owners only: removes this digest, its results and its uploaded images">Delete digest</button>') : ""}
        <span class="msg">${esc(S.busy || S.msg || (enz.length ? `${D.lanes.length} lane${D.lanes.length === 1 ? "" : "s"} · ${enz.length} enzyme${enz.length === 1 ? "" : "s"}${unset ? ` · ${unset} without a result` : ""}` : ""))}</span></div>
      </div>`;
  }

  // ---------- downloads ----------
  const fileStem = (kind) => `${String(S.phage.phage_name || "phage").replace(/[^A-Za-z0-9_-]+/g, "_")}${S.D.date ? "_" + S.D.date : ""}${kind === "control" ? "_control" : ""}`;
  function saveBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  function svgToCanvas(svg, scale) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      img.onload = () => { const c = document.createElement("canvas"); c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The virtual digest could not be drawn as a picture.")); };
      img.src = url;
    });
  }
  // A lab image can be copied into a picture only if its server allows it (the lab's own storage does).
  async function fetchImage(url) {
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error(`download returned ${r.status}`);
    const blob = await r.blob();
    return { blob, bmp: await createImageBitmap(blob) };
  }
  async function download(what) {
    const kind = S.tab, k = K(kind), stem = fileStem(kind);
    try {
      const vsvg = () => DG.gelSvg(gelLanes(kind), gelOpt());
      if (what === "virtual") { const c = await svgToCanvas(vsvg(), 2); c.toBlob((b) => saveBlob(b, `${stem}_virtual.png`), "image/png"); return; }
      let lab;
      try { lab = await fetchImage(k.img); } catch (err) {
        window.open(k.img, "_blank", "noopener");
        S.msg = `The ${k.ctl ? "control" : "lab"} image is kept on ${srcName(k.img)}, which doesn't let this page copy it, so it was opened in a new tab: save it from there.${what === "both" ? " A combined picture needs the image uploaded to this site." : ""}`;
        render(); return;
      }
      if (what === "lab") { saveBlob(lab.blob, `${stem}_lab.${/png/.test(lab.blob.type) ? "png" : "jpg"}`); return; }
      const v = await svgToCanvas(vsvg(), 2);
      const h = Math.max(lab.bmp.height, v.height), gap = 40, lw = Math.round(lab.bmp.width * (h / lab.bmp.height)), vw = Math.round(v.width * (h / v.height));
      const c = document.createElement("canvas"); c.width = lw + gap + vw; c.height = h;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(lab.bmp, 0, 0, lw, h); g.drawImage(v, lw + gap, 0, vw, h);
      c.toBlob((b) => saveBlob(b, `${stem}_lab_and_virtual.png`), "image/png");
    } catch (err) { S.msg = `Download failed: ${err.message || err}`; render(); }
  }

  // ---------- render and routing ----------
  let route = { name: "list" };
  function render() {
    const ae = document.activeElement, keepKey = ae && ae.dataset && ae.dataset.lf && ae.tagName === "INPUT" ? ae.dataset.lf : null, keep = keepKey ? ae.selectionStart : null;
    const here = route.name === "analysis" ? "#/analysis" : route.name === "quality" ? "#/quality" : route.name === "enzymes" ? "#/enzymes" : "#/";
    for (const a of document.querySelectorAll("header nav a")) a.classList.toggle("on", !!S.role && a.getAttribute("href") === here);
    userBox.innerHTML = S.user ? `${esc(S.name || S.user.email || "")}${S.role ? ` · ${esc(S.role)}` : ""} <button id="signout">Sign out</button>` : "";
    if (!S.user) app.innerHTML = viewSignIn(S.msg);
    else if (!S.role || S.role === "viewer") app.innerHTML = viewNoAccess();
    else if (route.name === "digest" && S.D) app.innerHTML = viewDigest();
    else if (route.name === "phage" && S.phage) app.innerHTML = viewPhage();
    else if (route.name === "enzymes") app.innerHTML = viewEnzymes();
    else if (route.name === "analysis") app.innerHTML = viewAnalysis();
    else if (route.name === "quality") app.innerHTML = viewQuality();
    else app.innerHTML = viewList();
    if (keepKey) { const f = app.querySelector(`input[data-lf="${keepKey}"]`); if (f) { f.focus(); f.setSelectionRange(keep, keep); } }
  }
  let lastHash = location.hash, guardOff = false;
  async function go() {
    if (route.name === "digest" && S.D && location.hash !== lastHash && !guardOff && isDirty()
      && !window.confirm("This digest has changes that are not saved.\n\nLeave without saving?")) { guardOff = true; location.hash = lastHash; return; }
    guardOff = false; lastHash = location.hash;
    const [pathPart, query] = location.hash.replace(/^#\/?/, "").split("?"), h = pathPart.split("/");
    try {
      if (!S.user || !S.role) { render(); return; }
      if (!S.catalog.length) await loadBase();
      if (h[0] === "enzymes") { S.D = null; S.ze = null; S.pe = null; S.presetDel = null; S.msg = ""; S.ezMsg = ""; route = { name: "enzymes" }; render(); return; }
      if (h[0] === "analysis") {
        if (query) { try { anApply(JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(new URLSearchParams(query).get("v") || "")))))); } catch (err) { /* an address that can't be read just opens the page */ } }
        S.D = null; route = { name: "analysis" }; S.an.loaded = false; render(); await loadAnalysis(); render(); return;
      }
      if (h[0] === "quality") { S.D = null; route = { name: "quality" }; S.an.loaded = false; render(); await loadAnalysis(); render(); return; }
      if (h[0] === "phage" && h[1]) {
        if (!S.phage || S.phage.phage_id !== h[1]) await loadPhage(h[1]);
        if (!S.phage) { location.hash = "#/"; return; }
        if (h[2] === "digest" && h[3]) {
          if (!S.D || (h[3] !== "new" && S.D.id !== h[3]) || (h[3] === "new" && !S.D.isNew)) openDigest(h[3]);
          route = { name: "digest" }; render(); loadGenome(); return;
        }
        S.D = null; S.msg = ""; route = { name: "phage" }; render(); return;
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
    if (ev.target.closest("[data-nogo]")) return;   // a tick-box cell inside a clickable row
    const qf = ev.target.closest("a[data-qf]");   // a count on the Data quality tab: set the Phages tab's filters; the link itself then opens #/
    if (qf) { const [g, dg] = qf.dataset.qf.split("|"); for (const k in S.filters) S.filters[k] = ""; S.filters.genome = g; S.filters.digest = dg; S.page = 0; return; }
    const t = ev.target.closest("button, a.btn, th[data-sort], th[data-asort], tr[data-go]");
    if (!t) return;
    if (t.dataset.asort) {
      const [tbl, k] = t.dataset.asort.split(":"), st = tbl === "main" ? S.an : S.an[tbl];
      st.sort = { k, dir: st.sort.k === k ? -st.sort.dir : TEXT_KEYS.has(k) ? 1 : -1 }; S.an.page = 0; render(); return;
    }
    if (t.dataset.adl) { analysisDownload(t.dataset.adl); return; }
    if (t.dataset.act === "queue") { S.an.qask = S.an.sel.size > 0; render(); return; }
    if (t.dataset.act === "queueno") { S.an.qask = false; render(); return; }
    if (t.dataset.act === "queueyes") { queueSelected(); return; }
    if (t.dataset.sort) { S.sort = { k: t.dataset.sort, dir: S.sort.k === t.dataset.sort ? -S.sort.dir : 1 }; S.page = 0; render(); return; }
    if (t.dataset.page) { S.page = Math.max(0, S.page + Number(t.dataset.page)); render(); return; }
    if (t.dataset.act === "recompute") { if (!S.an.busy) recomputeVirtual(); return; }
    if (t.dataset.act === "seqcand") { Object.assign(S.an, { show: "blocked", min: "3", seq: "no", sort: { k: "blocked", dir: -1 }, enz: "", q: "", host: "", page: 0 }); render(); return; }
    if (t.dataset.anpage) { S.an.page = Math.max(0, S.an.page + Number(t.dataset.anpage)); render();
      // Stay with the phage table: the top pager has not moved; after the bottom pager, bring the start of the table back into view (not the top of the page, which is Figure 1)
      const h = document.getElementById("anphages"); if (h && h.getBoundingClientRect().top < 0) h.scrollIntoView(); return; }
    if (t.dataset.act === "clearfilters") { for (const k in S.filters) S.filters[k] = ""; S.page = 0; render(); return; }
    if (t.id === "signout") { await sb.auth.signOut(); S.user = null; S.role = null; S.catalog = []; S.phage = null; S.D = null; render(); return; }
    if (t.dataset.go) { location.hash = t.dataset.go; return; }
    if (t.dataset.presetdel !== undefined) { if (t.dataset.yes) await deletePreset(t.dataset.presetdel); else S.presetDel = t.dataset.presetdel || null; render(); return; }
    if (t.dataset.ze) {
      if (t.dataset.ze === "edit") { const z = enzyme(t.dataset.id); S.ze = { id: z.restriction_enzyme_id, sens: z.modification_sensitivity || "", group: z.diagnostic_group || "", notes: z.notes || "" }; S.ezMsg = ""; }
      else if (t.dataset.ze === "cancel") S.ze = null;
      else if (t.dataset.ze === "save" && S.ze) {
        const r = await sb.from("restriction_enzymes").update({ modification_sensitivity: S.ze.sens.trim() || null, diagnostic_group: S.ze.group.trim() || null, notes: S.ze.notes.trim() || null }).eq("restriction_enzyme_id", S.ze.id);
        if (r.error) S.ezMsg = `Not saved: ${r.error.message || r.error}`;
        else { const enz = await sb.from("restriction_enzymes").select("*").eq("active", true).order("enzyme_name"); if (!enz.error) S.enzymes = enz.data || []; S.ze = null; S.ezMsg = "Enzyme details saved."; }
      }
      render(); return;
    }
    if (t.dataset.act === "anreset") { anApply(JSON.parse(AN_DEFAULT)); for (const f of ["f1", "f2", "f3", "f4"]) S.an[f].f = {}; S.an.sel = new Set(); S.an.msg = ""; buildAnalysis(); render(); return; }
    if (t.dataset.act === "anlink") {
      const url = `${location.origin}${location.pathname}${location.search}#/analysis?v=${encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(anState())))))}`;
      const done = (ok) => { S.an.msg = ok ? "Link copied. Paste it into a message to share this view." : `Copy this address: ${url}`; render(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => done(true), () => done(false)); else done(false);
      return;
    }
    if (t.dataset.pe) {
      const a = t.dataset.pe;
      if (a === "save") { if (S.pe) await savePresetEdit(); return; }
      if (a === "new") S.pe = { id: null, name: "", lanes: ["L", "U"] };
      else if (a === "edit") { const P = S.presets.find((x) => x.restriction_enzyme_preset_id === t.dataset.id); if (P) S.pe = { id: P.restriction_enzyme_preset_id, name: P.preset_name, lanes: (Array.isArray(P.lane_layout) ? P.lane_layout : []).slice() }; }
      else if (a === "cancel") S.pe = null;
      else if (a === "addladder" && S.pe) S.pe.lanes.push("L");
      S.msg = ""; S.presetDel = null; render(); return;
    }
    if (t.dataset.pemove !== undefined && S.pe) { const L = S.pe.lanes, i = Number(t.dataset.pemove), j = i + Number(t.dataset.dir); if (j >= 0 && j < L.length) { const x = L[i]; L[i] = L[j]; L[j] = x; render(); } return; }
    const D = S.D;
    if (!D) return;
    if (t.dataset.act === "save") { save(); return; }
    if (t.dataset.act === "savenext") { saveAndNext(); return; }
    if (t.dataset.act === "cancel") { guardOff = true; S.D = null; S.msg = ""; location.hash = `#/phage/${S.phage.phage_id}`; return; }   // Cancel is the answer, so no second question
    if (t.dataset.act === "del") { D.delAsk = true; render(); return; }
    if (t.dataset.act === "delno") { D.delAsk = false; render(); return; }
    if (t.dataset.act === "delyes") { deleteDigest(); return; }
    if (t.dataset.zoom !== undefined) {
      const d = Number(t.dataset.zoom), k = d ? Math.min(5, Math.max(1, Math.round((S.zoom.k + d * 0.5) * 10) / 10)) : 1;
      S.zoom = k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: S.zoom.x, y: S.zoom.y }; render(); return;
    }
    if (t.dataset.act === "togglevirtual") { D.showStoredVirtual = !D.showStoredVirtual; render(); return; }
    if (t.dataset.preset) { applyPreset(t.dataset.preset); render(); return; }
    if (t.dataset.act === "presetsave") { const f = app.querySelector("[data-presetname]"); savePreset(f ? f.value : D.presetName); return; }
    if (t.dataset.add) { addLane(t.dataset.add); render(); return; }
    if (t.dataset.control) { D.control = t.dataset.control === "none" ? "none" : t.dataset.control === "true"; S.msg = ""; render(); return; }
    if (t.dataset.call !== undefined) { const L = D.lanes[Number(t.dataset.call)]; if (L && !L.sp) { K(S.tab).set(L, t.dataset.val); S.cur = Number(t.dataset.call); S.msg = ""; render(); } return; }
    if (t.dataset.act === "ctlall") { for (const L of D.lanes) if (!L.sp) D.controlCalls[L.id] = "Digestion"; S.msg = ""; render(); return; }
    if (t.dataset.act === "ctlclear") { D.controlCalls = {}; S.msg = ""; render(); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.msg = ""; if (S.tab === "control" && !S.control) { render(); await loadControl(); } render(); return; }
    if (t.dataset.dl) { download(t.dataset.dl); return; }
    if (t.dataset.emove !== undefined) {   // swap with the nearest enzyme lane on that side, stepping over ladder and uncut lanes
      const i = Number(t.dataset.emove), d = Number(t.dataset.dir); let j = i + d;
      while (j >= 0 && j < D.lanes.length && D.lanes[j].sp) j += d;
      if (j >= 0 && j < D.lanes.length) { const x = D.lanes[i]; D.lanes[i] = D.lanes[j]; D.lanes[j] = x; S.msg = "Lane order changed. Save to keep it."; render(); }
      return;
    }
    if (t.dataset.move !== undefined) { const i = Number(t.dataset.move), j = i + Number(t.dataset.dir); if (j >= 0 && j < D.lanes.length) { const x = D.lanes[i]; D.lanes[i] = D.lanes[j]; D.lanes[j] = x; render(); } return; }
    if (t.dataset.drop !== undefined) { const L = D.lanes[Number(t.dataset.drop)]; if (L && L.sp) D.lanes.splice(Number(t.dataset.drop), 1); else if (L) toggleEnzyme(L.id, false); render(); return; }
  });
  document.addEventListener("change", async (ev) => {
    const t = ev.target, D = S.D;
    if (t.id === "pagesize") { S.pageSize = Number(t.value) || 25; S.page = 0; render(); return; }
    if (t.dataset.lf && t.tagName === "SELECT") { S.filters[t.dataset.lf] = t.value; S.page = 0; render(); return; }
    if (t.dataset.an && t.tagName === "SELECT") { setPath(S.an, t.dataset.an, t.value); S.an.page = 0; if (t.dataset.an === "chk") buildAnalysis(); render(); return; }
    if (t.dataset.asel) { if (t.checked) S.an.sel.add(t.dataset.asel); else S.an.sel.delete(t.dataset.asel); S.an.qask = false; render(); return; }
    if (t.dataset.aselall !== undefined) { for (const id of S.an.shownIds) { if (t.checked) S.an.sel.add(id); else S.an.sel.delete(id); } S.an.qask = false; render(); return; }
    if (t.dataset.acheck) { S.an[t.dataset.acheck] = t.checked; render(); return; }
    if (t.dataset.genomeup !== undefined && t.files[0] && D) { uploadGenome(t.files[0]); return; }
    if (t.dataset.chk !== undefined && D) { D.checked = t.checked; if (!t.checked) D.checkedAt = null; return; }
    if (t.dataset.replicate !== undefined && t.files[0] && S.phage) { addReplicateImage(t.files[0]); return; }
    if (t.dataset.petoggle && S.pe) {
      const k = t.dataset.petoggle, L = S.pe.lanes;
      if (!t.checked) S.pe.lanes = L.filter((x) => x !== k);
      else if (k === "L") L.unshift("L"); else if (k === "U") L.splice(L[0] === "L" ? 1 : 0, 0, "U"); else L.push(k);
      render(); return;
    }
    if (!D) return;
    if (t.dataset.pick) { toggleEnzyme(t.dataset.pick, t.checked); render(); return; }
    if (t.dataset.gelopt) { GEL_OPT[t.dataset.gelopt] = t.checked; saveGelOpt(); render(); return; }
    if (t.dataset.guide !== undefined) { S.guide.on = t.checked; render(); return; }
    if (t.dataset.gelnum) { saveGelOpt(); return; }
    if (t.dataset.sp) { if (t.checked) addLane(t.dataset.sp); else D.lanes = D.lanes.filter((L) => L.sp !== t.dataset.sp); render(); return; }
    if (t.dataset.f) { D[t.dataset.f] = t.value; if (t.dataset.redraw !== undefined) render(); return; }
    if (t.dataset.upload && t.files[0]) { uploadImage(t.dataset.upload, t.files[0]); return; }
    if (t.dataset.controlfasta !== undefined && t.files[0]) {
      const f = DG.parseFasta(await t.files[0].text());
      if (f.seq.length < 100) { S.msg = "No DNA sequence was found in that file."; } else { S.control = { seq: f.seq, name: f.name || t.files[0].name }; D.controlName = S.control.name.slice(0, 80); }
      render();
    }
  });
  // The height and run-time sliders redraw only the virtual gel, so the slider keeps moving under the pointer.
  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (!t.dataset || !t.dataset.gelnum || !S.D) return;
    if (t.dataset.gelnum === "run") GEL_OPT.run = Number(t.value) / 100; else GEL_OPT[t.dataset.gelnum] = Number(t.value);
    const o = t.parentElement.querySelector("output"); if (o) o.textContent = t.dataset.gelnum === "run" ? `${t.value}%` : `${t.value}px`;
    const v = document.getElementById("vgel"); if (v && K(S.tab).seq) v.innerHTML = virtualGel(S.tab);
  });
  // The guide line is dragged directly; its position is kept when the page redraws.
  document.addEventListener("pointerdown", (ev) => {
    const zw = ev.target.closest && ev.target.closest(".zoomwrap");
    if (zw && S.zoom && S.zoom.k > 1) {   // drag a zoomed gel image to move it
      ev.preventDefault();
      const img = zw.querySelector("img"), x0 = ev.clientX - S.zoom.x, y0 = ev.clientY - S.zoom.y, minX = -zw.clientWidth * (S.zoom.k - 1), minY = -img.offsetHeight * (S.zoom.k - 1);
      const mv = (e2) => { S.zoom.x = Math.max(minX, Math.min(0, e2.clientX - x0)); S.zoom.y = Math.max(minY, Math.min(0, e2.clientY - y0)); img.style.transform = `translate(${S.zoom.x}px,${S.zoom.y}px) scale(${S.zoom.k})`; };
      const end = () => { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", end); };
      document.addEventListener("pointermove", mv); document.addEventListener("pointerup", end);
      return;
    }
    const gline = ev.target.closest && ev.target.closest("#guide");
    if (!gline) return;
    ev.preventDefault();
    const box = document.getElementById("gels"), top0 = box.getBoundingClientRect().top;
    const move = (e2) => { S.guide.y = Math.max(0, Math.min(box.offsetHeight - 2, Math.round(e2.clientY - top0))); gline.style.top = S.guide.y + "px"; };
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.dataset && ev.target.dataset.lf && ev.target.tagName === "INPUT") { S.filters[ev.target.dataset.lf] = ev.target.value; S.page = 0; render(); }
    else if (ev.target.dataset && ev.target.dataset.f && S.D) S.D[ev.target.dataset.f] = ev.target.value;
  });
  document.addEventListener("toggle", (ev) => { const k = ev.target.dataset && ev.target.dataset.sec; if (k) S.open[k] = ev.target.open; }, true);
  document.addEventListener("input", (ev) => { const t = ev.target; if (S.pe && t.dataset && t.dataset.pename !== undefined) S.pe.name = t.value; if (S.ze && t.dataset && t.dataset.zef) S.ze[t.dataset.zef] = t.value; });
  document.addEventListener("submit", (ev) => {
    if (ev.target.id !== "enzadd") return;
    ev.preventDefault();
    const f = new FormData(ev.target), v = {};
    for (const x of ENZ_FIELDS) v[x[0]] = String(f.get(x[0]) || "");
    S.ezMsg = "Adding…"; addEnzyme(v);
  });
  // The analysis text filters redraw as you type and keep the cursor where it was.
  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (!t.dataset || !t.dataset.ain) return;
    setPath(S.an, t.dataset.ain, t.value); S.an.page = 0; const pos = t.selectionStart, path = t.dataset.ain; render();
    const f = app.querySelector(`input[data-ain="${path}"]`); if (f) { f.focus(); try { f.setSelectionRange(pos, pos); } catch (err) { /* not a text field */ } }
  });
  window.addEventListener("hashchange", go);
  window.addEventListener("beforeunload", (ev) => { if (route.name === "digest" && isDirty()) { ev.preventDefault(); ev.returnValue = ""; } });
  // Digest page keys: arrows choose the enzyme, 1 to 4 set its result.
  document.addEventListener("keydown", (ev) => {
    if (route.name !== "digest" || !S.D || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = (ev.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    const D = S.D, enz = D.lanes.map((L, i) => (L.sp ? -1 : i)).filter((i) => i >= 0);
    if (!enz.length) return;
    const pos = Math.max(0, enz.indexOf(S.cur));
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { S.cur = enz[Math.min(enz.length - 1, Math.max(0, pos + (ev.key === "ArrowRight" ? 1 : -1)))]; ev.preventDefault(); render(); return; }
    const n = ev.key.length === 1 ? "1234".indexOf(ev.key) : -1;
    if (n >= 0) { K(S.tab).set(D.lanes[enz[pos]], CALL_BTN[n][0]); S.cur = enz[Math.min(enz.length - 1, pos + 1)]; S.msg = ""; ev.preventDefault(); render(); }
  });

  (async function start() {
    app.innerHTML = '<p class="sub">Loading…</p>';
    await loadSession();
    go();
  })();
})();
