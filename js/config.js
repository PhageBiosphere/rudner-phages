// Settings for the Phage DNA Modification Analysis site (Rudner Lab).
// Moving the database to another server means changing SUPABASE_URL and SUPABASE_KEY here, nothing else.
window.RUDNER_CONFIG = {
  SUPABASE_URL: "https://hbsqfdcdvluygqhlmsub.supabase.co",
  // The publishable key is meant to be public: the database's own rules decide who may read or change what.
  SUPABASE_KEY: "sb_publishable_Bi5WDW6j4NkWTnPJUA-AiA_4KgpqM8g",
  LOGIN_DOMAIN: "example.com",        // a user name without @ signs in as name@LOGIN_DOMAIN, as on the Observable page
  IMAGE_BUCKET: "digest-images",      // public storage bucket for gel images
  IMAGE_MAX_SIDE: 2000,               // uploads are resized so the longer side is at most this many pixels
  IMAGE_QUALITY: 0.85,                // JPEG quality of the resized image
  LADDERS: ["1 kb ladder (EcoRV + NcoI)", "100 bp ladder (PstI + NcoI)", "1 kb ladder (NEB)", "100 bp ladder (NEB)"]
};
