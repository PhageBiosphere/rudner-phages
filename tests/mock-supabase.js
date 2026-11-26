// A stand-in for the lab database, loaded before the site in every test. The site uses window.__TEST_SUPABASE__
// when it exists, so no test ever touches the real database. Data: 12 made-up phages with fixed results.
(() => {
  const ENZ = "BamHI:GGATCC BstUI:CGCG EcoRI:GAATTC HaeIII:GGCC KpnI:GGTACC NspI:RCATGY SacII:CCGCGG SalI:GTCGAC SmaI:CCCGGG MseI:TTAA DraI:TTTAAA"
    .split(" ").map((x, i) => ({ restriction_enzyme_id: "e" + i, enzyme_name: x.split(":")[0], recognition_sequence: x.split(":")[1], modification_sensitivity: null, diagnostic_group: null, notes: null, active: true }));
  const role = window.__TEST_ROLE__ || "owner";
  const DB = { lab_members: [{ user_id: "u1", role, display_name: "Tester", active: true }], restriction_enzymes: ENZ, phage_catalog_public: [], restriction_digest_experiments: [], restriction_digest_results: [],
    gene_browse_public: [], restriction_enzyme_presets: [{ restriction_enzyme_preset_id: "pre1", preset_name: "GC-rich", lane_layout: ["L", "U", "e0", "e7", "e4"] }], sequencing_requests: [], phage_workflow_status_public: [], phage_genes_public: [] };
  const hosts = [["Arthrobacter", "globiformis", "B-2880"], ["Mycobacterium", "smegmatis", "mc2155"], ["Streptomyces", "avermitilis", "8165"]];
  const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";   // a one-pixel picture standing in for a gel
  const gcOnly = (s) => /^[GC]+$/.test(s), atOnly = (s) => /^[AT]+$/.test(s);
  for (let i = 0; i < 12; i++) {
    const id = "p" + String(i).padStart(2, "0"), h = hosts[i % 3], seqd = i % 4 === 0;
    DB.phage_catalog_public.push({ phage_id: id, lab_phage_id: "RUD-" + String(i + 1).padStart(6, "0"), phage_name: "Phage" + String(i).padStart(2, "0"), host_genus: h[0], host_species: h[1], host_strain: h[2],
      phagesdb_cluster: seqd ? "AZ" : null, phagesdb_subcluster: seqd ? "AZ1" : null, genome_length_bp: seqd ? 40000 + i : null, restriction_digest_image_url: i === 7 ? PIXEL : null });
    if (i === 11) continue;   // Phage11 has no digest at all
    DB.restriction_digest_experiments.push({ restriction_digest_experiment_id: "x" + id, phage_id: id, experiment_date: null, positive_control_passed: null, no_control: true, results_checked: i === 0, control_name: "Lambda DNA",
      control_results: {}, lane_layout: ["L", "U"].concat(ENZ.map((z) => z.restriction_enzyme_id)), created_at: "2026-01-01T00:00:00Z" });
    ENZ.forEach((z, j) => {
      // phages 0-3: every G/C-only enzyme blocked; 4-5: every A/T-only enzyme blocked; 6: both; 7-10: everything cut
      let o = "Digestion";
      if (i <= 3 && gcOnly(z.recognition_sequence)) o = "No digestion";
      if ((i === 4 || i === 5) && atOnly(z.recognition_sequence)) o = "No digestion";
      if (i === 6 && (gcOnly(z.recognition_sequence) || atOnly(z.recognition_sequence))) o = "No digestion";
      DB.restriction_digest_results.push({ restriction_digest_result_id: "r" + id + "_" + String(j).padStart(2, "0"), restriction_digest_experiment_id: "x" + id, restriction_enzyme_id: z.restriction_enzyme_id, lane_number: j + 3, observed_result: o, virtual_digest_result: seqd ? "Digestion" : null });
    });
  }
  // Annotated genes for four phages, to exercise the modification-island search.
  const gene = (pid, n, start, end, product) => ({ source: "lab", gene_key: `L:${pid}:${n}`, phage_id: pid, gene_number: String(n), start_bp: start, end_bp: end, strand: "+", product });
  DB.gene_browse_public = [
    gene("p00", 1, 100, 900, "terminase small subunit"), gene("p00", 7, 5000, 6000, "queuine tRNA-ribosyltransferase"), gene("p00", 8, 6100, 6400, "hypothetical protein"), gene("p00", 9, 6500, 7200, "QueC"), gene("p00", 10, 7300, 8000, "glutamine amidotransferase domain protein"), gene("p00", 30, 30000, 31000, "major capsid protein"),
    gene("p02", 3, 2000, 2900, "thymidylate synthase"), gene("p02", 5, 4000, 5000, "glycosyltransferase"),
    gene("p04", 12, 20000, 21200, "DNA methyltransferase"), gene("p04", 13, 21300, 21900, "hypothetical protein"),
    gene("p08", 2, 1000, 1800, "dCMP hydroxymethylase"), gene("p08", 40, 30000, 31000, "glucosyltransferase"), gene("p08", 41, 31100, 31500, "hypothetical protein")
  ];
  let n = 0; const copy = (x) => JSON.parse(JSON.stringify(x)), files = new Map();
  function from(t) {
    const st = { f: [], op: "select", single: false, range: null };
    const run = () => {
      if (!DB[t]) return { data: null, error: { message: "no table " + t } };
      const m = (r) => st.f.every((f) => f(r));
      if (st.op === "insert") { for (const r of [].concat(st.v)) { const key = { restriction_enzyme_presets: "restriction_enzyme_preset_id", restriction_enzymes: "restriction_enzyme_id", restriction_digest_results: "restriction_digest_result_id" }[t]; if (key && !r[key]) r[key] = "new" + ++n; DB[t].push(copy(r)); } return { data: null, error: null }; }
      if (st.op === "update") { DB[t].filter(m).forEach((r) => Object.assign(r, copy(st.v))); return { data: null, error: null }; }
      if (st.op === "delete") { DB[t] = DB[t].filter((r) => !m(r)); return { data: null, error: null }; }
      let out = copy(DB[t].filter(m)); if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      return { data: st.single ? out[0] || null : out, error: null };
    };
    const o = { select: () => o, order: () => o, range: (a, b) => { st.range = [a, b]; return o; }, eq: (k, v) => { st.f.push((r) => r[k] === v); return o; }, in: (k, v) => { st.f.push((r) => v.includes(r[k])); return o; },
      ilike: (k, v) => { st.f.push((r) => String(r[k]).toLowerCase() === String(v).toLowerCase()); return o; }, maybeSingle: () => { st.single = true; return o; },
      insert: (v) => { st.op = "insert"; st.v = v; return o; }, update: (v) => { st.op = "update"; st.v = v; return o; }, delete: () => { st.op = "delete"; return o; }, then: (res, rej) => Promise.resolve(run()).then(res, rej) };
    return o;
  }
  window.__DB__ = DB; window.__FILES__ = files; window.__RPC__ = [];
  window.__TEST_SUPABASE__ = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "tester@example.com" } } } }), signOut: async () => ({}) },
    from,
    rpc: async (name, args) => { window.__RPC__.push([name, args]); for (const id of args.p_phage_ids || []) DB.sequencing_requests.push({ phage_id: id, status: "queued" }); return { data: { added: (args.p_phage_ids || []).length, status: "queued", already_waiting: [], already_on_unsequenced_sample_set: [] }, error: null }; },
    functions: { invoke: async () => ({ data: { error: "No genome sequence is available for this phage yet." }, error: null }) },
    storage: { from: (bucket) => ({
      getPublicUrl: (p) => ({ data: { publicUrl: p ? "/data/lambda.fasta?" + p : "" } }),
      upload: async (p, blob) => { files.set(bucket + "/" + p, await blob.text()); return { error: null }; },
      list: async () => ({ data: [...files.keys()].filter((k) => k.startsWith(bucket + "/")).map((k) => ({ name: k.slice(bucket.length + 1) })), error: null }),
      download: async (p) => (files.has(bucket + "/" + p) ? { data: new Blob([files.get(bucket + "/" + p)]), error: null } : { data: null, error: { message: "not found" } }),
      remove: async (ps) => { for (const p of ps) files.delete(bucket + "/" + p); return { error: null }; }
    }) }
  };
})();
