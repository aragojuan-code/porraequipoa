const cfg = window.PORRA_EQUIPO_A_CONFIG || {};
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProfile = null;

function show(viewId) {
  ["landingView", "authView", "dashboardView", "poolView"].forEach(id => $(id).classList.add("hidden"));
  $(viewId).classList.remove("hidden");
}

function toast(msg, ms = 3200) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), ms);
}

function cleanCode(v) {
  return String(v || "").trim().toUpperCase();
}

async function loadSession() {
  const { data } = await sb.auth.getSession();
  currentUser = data.session?.user || null;

  if (currentUser) {
    await loadProfile();
    await loadDashboard();
  } else {
    show("landingView");
  }
}

async function loadProfile() {
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error) {
    console.warn(error);
    currentProfile = null;
    return;
  }

  currentProfile = data;
}

async function loadDashboard() {
 $("userLine").textContent = currentProfile
  ? `Conectado como ${currentProfile.display_name}`
  : `Conectado como ${currentUser.email}`;

  show("dashboardView");
  await renderPools();
}

async function renderPools() {
  const list = $("poolsList");
  list.innerHTML = `<p class="muted">Cargando porras...</p>`;

  const { data, error } = await sb
    .from("my_pools")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    list.innerHTML = `<p class="muted">No se pudieron cargar las porras: ${error.message}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = `<p class="muted">Todavía no estás en ninguna porra. Crea una o únete con código.</p>`;
    return;
  }

  list.innerHTML = "";
  data.forEach(pool => {
    const item = document.createElement("div");
    item.className = "pool-item";
    item.innerHTML = `
      <div>
        <div class="pool-name">${escapeHtml(pool.name)}</div>
        <div class="pool-meta">
          Código <span class="code">${escapeHtml(pool.invite_code)}</span>
          · ${pool.member_count} miembro(s)
          · rol: ${escapeHtml(pool.role)}
        </div>
      </div>
      <button class="secondary-btn" type="button">Abrir</button>
    `;
    item.querySelector("button").addEventListener("click", () => openPool(pool.id));
    list.appendChild(item);
  });
}

async function openPool(poolId) {
  const { data: pool, error: poolError } = await sb
    .from("pools")
    .select("*")
    .eq("id", poolId)
    .single();

  if (poolError) {
    toast(poolError.message);
    return;
  }

  const { data: members, error: membersError } = await sb
    .from("pool_members")
    .select("role, joined_at, profiles:user_id(username, display_name)")
    .eq("pool_id", poolId)
    .order("joined_at", { ascending: true });

  if (membersError) {
    toast(membersError.message);
    return;
  }

 const memberRows = (members || []).map(m => `
  <li>
    <strong>${escapeHtml(m.profiles?.display_name || "Usuario")}</strong>
    <span class="muted">· ${escapeHtml(m.role)}</span>
  </li>
`).join("");

  $("poolDetail").innerHTML = `
    <div class="card">
      <div class="card-kicker">PORRA PRIVADA</div>
      <h1>${escapeHtml(pool.name)}</h1>
      <p>Código para invitar amigos:</p>
      <span class="code big-code">${escapeHtml(pool.invite_code)}</span>
      <p class="muted">
        Próxima fase: añadir competición, equipos, jugadores, pichichi y predicciones.
      </p>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-kicker">MIEMBROS</div>
      <ul>${memberRows || "<li>No hay miembros.</li>"}</ul>
    </div>
  `;

  show("poolView");
}

async function registerUser(e) {
  e.preventDefault();

  const email = $("regEmail").value.trim();
  const password = $("regPassword").value;
  const displayName = $("regDisplayName").value.trim();

if (!displayName || displayName.length < 2) {
  toast("El nombre visible debe tener al menos 2 caracteres.");
  return;
}

const displayNameKey = displayName.toLowerCase().replace(/\s+/g, " ").trim();
const username = displayNameKey
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "")
  .slice(0, 32);

  const { data, error } = await sb.auth.signUp({
    email,
    password
  });

  if (error) {
    toast(error.message);
    return;
  }

  const user = data.user;
  if (!user) {
    toast("Revisa tu email para confirmar la cuenta.");
    return;
  }

  const { error: profileError } = await sb.from("profiles").insert({
  id: user.id,
  username,
  display_name: displayName,
  display_name_key: displayNameKey
});

if (profileError) {
  if (
    profileError.code === "23505" ||
    String(profileError.message || "").toLowerCase().includes("duplicate")
  ) {
    toast("Ese nombre visible ya está registrado. Elige otro.");
    return;
  }

  toast(`Cuenta creada, pero falló el perfil: ${profileError.message}`);
  return;
}

  

  toast("Cuenta creada. Si Supabase pide confirmación por email, confirma antes de entrar.");
  await loadSession();
}

async function loginUser(e) {
  e.preventDefault();

  const { error } = await sb.auth.signInWithPassword({
    email: $("loginEmail").value.trim(),
    password: $("loginPassword").value
  });

  if (error) {
    toast(error.message);
    return;
  }

  await loadSession();
}

async function logoutUser() {
  await sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  show("landingView");
}

async function createPool(e) {
  e.preventDefault();

  const name = $("poolName").value.trim();
  if (name.length < 3) {
    toast("El nombre de la porra es demasiado corto.");
    return;
  }

  const { data, error } = await sb.rpc("create_pool_with_owner", {
    pool_name: name
  });

  if (error) {
    toast(error.message);
    return;
  }

  $("poolName").value = "";
  toast(`Porra creada. Código: ${data.invite_code}`);
  await renderPools();
  await openPool(data.id);
}

async function joinPool(e) {
  e.preventDefault();

  const code = cleanCode($("joinCode").value);
  if (!code) {
    toast("Introduce un código.");
    return;
  }

  const { data, error } = await sb.rpc("join_pool_by_code", {
    code_input: code
  });

  if (error) {
    toast(error.message);
    return;
  }

  $("joinCode").value = "";
  toast("Ya formas parte de la porra.");
  await renderPools();
  await openPool(data);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Música original NO. Esto genera un loop propio muy simple con Web Audio.
let audioCtx = null;
let loopTimer = null;

function startMissionSound() {
  if (audioCtx) {
    stopMissionSound();
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  $("soundBtn").textContent = "🔇 Apagar modo misión";

  let step = 0;
  const notes = [110, 110, 146.83, 164.81, 110, 82.41, 98, 110];

  function tick() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = step % 4 === 0 ? "sawtooth" : "square";
    osc.frequency.value = notes[step % notes.length];

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.18);

    step += 1;
  }

  tick();
  loopTimer = setInterval(tick, 220);
}

function stopMissionSound() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  $("soundBtn").textContent = "🔊 Activar modo misión";
}

$("showRegisterBtn").addEventListener("click", () => {
  show("authView");
  $("registerForm").classList.remove("hidden");
  $("loginForm").classList.add("hidden");
});

$("showLoginBtn").addEventListener("click", () => {
  show("authView");
  $("loginForm").classList.remove("hidden");
  $("registerForm").classList.add("hidden");
});

$("goLoginBtn").addEventListener("click", () => {
  $("registerForm").classList.add("hidden");
  $("loginForm").classList.remove("hidden");
});

$("goRegisterBtn").addEventListener("click", () => {
  $("loginForm").classList.add("hidden");
  $("registerForm").classList.remove("hidden");
});

$("registerForm").addEventListener("submit", registerUser);
$("loginForm").addEventListener("submit", loginUser);
$("logoutBtn").addEventListener("click", logoutUser);
$("createPoolForm").addEventListener("submit", createPool);
$("joinPoolForm").addEventListener("submit", joinPool);
$("backDashboardBtn").addEventListener("click", loadDashboard);
$("soundBtn").addEventListener("click", startMissionSound);

sb.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user || null;
});

loadSession();
