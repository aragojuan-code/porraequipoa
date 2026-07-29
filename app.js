const cfg = window.PORRA_EQUIPO_A_CONFIG || {};

const sb = window.supabase.createClient(
  cfg.SUPABASE_URL,
  cfg.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage
    }
  }
);

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let currentPool = null;
let currentPoolMembers = [];
let competitionsCache = [];
let booting = false;

function isCurrentPoolAdmin() {
  return currentPoolMembers.some(
    (member) =>
      member.user_id === currentUser?.id &&
      (member.role === "owner" || member.role === "admin")
  );
}

function show(viewId) {
  [
    "landingView",
    "authView",
    "dashboardView",
    "poolView",
    "betView",
    "myBetView",
    "rankingView",
    "adminResultsView"
  ].forEach((id) => {
    const el = $(id);
    if (el) el.classList.add("hidden");
  });

  const target = $(viewId);
  if (target) target.classList.remove("hidden");
}

function toast(msg, ms = 3600) {
  const el = $("toast");

  if (!el) {
    alert(msg);
    return;
  }

  el.textContent = msg;
  el.classList.remove("hidden");

  setTimeout(() => {
    el.classList.add("hidden");
  }, ms);
}

function cleanCode(v) {
  return String(v || "").trim().toUpperCase();
}

function isPoolClosed(pool) {
  if (!pool || !pool.predictions_close_at) return false;
  return new Date(pool.predictions_close_at).getTime() <= Date.now();
}

function formatDate(value) {
  if (!value) return "Sin fecha";

  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getSign(home, away) {
  if (home > away) return "H";
  if (home < away) return "A";
  return "D";
}

function scorePrediction(pred, match) {
  if (
    match.home_goals === null ||
    match.home_goals === undefined ||
    match.away_goals === null ||
    match.away_goals === undefined
  ) {
    return {
      points: null,
      label: "Pendiente",
      cls: "result-pending"
    };
  }

  if (
    Number(pred.home_goals) === Number(match.home_goals) &&
    Number(pred.away_goals) === Number(match.away_goals)
  ) {
    return {
      points: 3,
      label: "Exacto",
      cls: "result-exact"
    };
  }

  const predSign = getSign(Number(pred.home_goals), Number(pred.away_goals));
  const realSign = getSign(Number(match.home_goals), Number(match.away_goals));

  if (predSign === realSign) {
    return {
      points: 1,
      label: "Signo",
      cls: "result-sign"
    };
  }

  return {
    points: 0,
    label: "Fallado",
    cls: "result-bad"
  };
}

function realScoreText(match) {
  if (
    match.home_goals === null ||
    match.home_goals === undefined ||
    match.away_goals === null ||
    match.away_goals === undefined
  ) {
    return "Pendiente";
  }

  return `${match.home_goals} - ${match.away_goals}`;
}

async function bootApp() {
  if (booting) return;
  booting = true;

  try {
    console.log("=== BOOT APP ===");

    const { data, error } = await sb.auth.getSession();

    console.log("Session response:", { data, error });

    if (error) {
      console.error("Session error:", error);
      show("landingView");
      return;
    }

    const session = data.session;

    if (!session || !session.user) {
      currentUser = null;
      currentProfile = null;
      show("landingView");
      return;
    }

    currentUser = session.user;

    const profile = await ensureProfileForCurrentUser();

    if (!profile) {
      alert("Hay sesión iniciada, pero no se pudo cargar o crear tu perfil.");
      showLogin();
      return;
    }

    currentProfile = profile;

    await loadDashboard();
  } catch (err) {
    console.error("Boot fatal error:", err);
    alert("Error cargando la app: " + err.message);
    show("landingView");
  } finally {
    booting = false;
  }
}

async function fetchProfile(userId) {
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  console.log("Profile response:", { data, error });

  if (error) {
    console.error("Profile error:", error);
    return null;
  }

  return data || null;
}

async function ensureProfileForCurrentUser() {
  if (!currentUser) return null;

  let profile = await fetchProfile(currentUser.id);

  if (profile) return profile;

  const proposedName = prompt(
    "Elige tu nombre visible. Será el nombre que aparecerá en todas tus porras privadas y no puede estar repetido."
  );

  if (!proposedName) return null;

  const { data, error } = await sb.rpc("ensure_my_profile", {
    name_input: proposedName
  });

  console.log("Created profile response:", { data, error });

  if (error) {
    alert("Error creando perfil: " + error.message);
    return null;
  }

  return data;
}

function showLogin() {
  show("authView");
  $("loginForm")?.classList.remove("hidden");
  $("registerForm")?.classList.add("hidden");
}

function showRegister() {
  show("authView");
  $("registerForm")?.classList.remove("hidden");
  $("loginForm")?.classList.add("hidden");
}

async function loadCompetitions() {
  const select = $("competitionSelect");
  if (!select) return;

  const { data, error } = await sb
    .from("competitions")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Competitions error:", error);
    toast("No se pudieron cargar competiciones: " + error.message);
    return;
  }

  competitionsCache = data || [];
  select.innerHTML = "";

  if (competitionsCache.length === 0) {
    select.innerHTML = `<option value="">No hay competiciones</option>`;
    return;
  }

  competitionsCache.forEach((competition) => {
    const option = document.createElement("option");
    option.value = competition.id;
    option.textContent = `${competition.name}${
      competition.season ? " · " + competition.season : ""
    }`;
    select.appendChild(option);
  });
}

async function loadDashboard() {
  const userLine = $("userLine");

  if (userLine) {
    userLine.textContent = currentProfile
      ? `Conectado como ${currentProfile.display_name}`
      : `Conectado como ${currentUser.email}`;
  }

  show("dashboardView");

  await loadCompetitions();
  await renderPools();
}

async function renderPools() {
  const list = $("poolsList");
  if (!list) return;

  list.innerHTML = `<p class="muted">Cargando porras...</p>`;

  const { data, error } = await sb
    .from("my_pools")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("my_pools error:", error);
    list.innerHTML = `<p class="muted">No se pudieron cargar las porras: ${escapeHtml(
      error.message
    )}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = `<p class="muted">Todavía no estás en ninguna porra. Crea una o únete con código.</p>`;
    return;
  }

  list.innerHTML = "";

  data.forEach((pool) => {
    const item = document.createElement("div");
    item.className = "pool-item";

    item.innerHTML = `
      <div>
        <div class="pool-name">${escapeHtml(pool.name)}</div>
        <div class="pool-meta">
          Código <span class="code">${escapeHtml(pool.invite_code)}</span>
          · ${pool.member_count} miembro(s)
          · rol: ${escapeHtml(pool.role)}
          ${pool.competition_name ? `· ${escapeHtml(pool.competition_name)}` : ""}
        </div>
      </div>
      <button class="secondary-btn" type="button">Abrir</button>
    `;

    item.querySelector("button").addEventListener("click", () => {
      openPool(pool.id);
    });

    list.appendChild(item);
  });
}

async function fetchPool(poolId) {
  const { data, error } = await sb
    .from("pools")
    .select("*, competitions:competition_id(name, season)")
    .eq("id", poolId)
    .single();

  if (error) throw error;

  return data;
}

async function openPool(poolId) {
  const { data: pool, error: poolError } = await sb
    .from("pools")
    .select("*, competitions:competition_id(name, season)")
    .eq("id", poolId)
    .single();

  if (poolError) {
    console.error("Pool error:", poolError);
    toast(poolError.message);
    return;
  }

  currentPool = pool;

  const { data: members, error: membersError } = await sb
    .from("pool_members")
    .select("user_id, role, joined_at, profiles:user_id(display_name)")
    .eq("pool_id", poolId)
    .order("joined_at", { ascending: true });

  if (membersError) {
    console.error("Members error:", membersError);
    toast(membersError.message);
    return;
  }

  currentPoolMembers = members || [];

  const memberRows = currentPoolMembers
    .map((member) => {
      return `
        <li>
          <strong>${escapeHtml(member.profiles?.display_name || "Usuario")}</strong>
          <span class="muted">· ${escapeHtml(member.role)}</span>
        </li>
      `;
    })
    .join("");

  const closed = isPoolClosed(pool);

  const statusHtml = closed
    ? `<span class="status-pill status-closed">🔒 Apuestas cerradas</span>`
    : `<span class="status-pill status-open">✅ Apuestas abiertas</span>`;

  const poolDetail = $("poolDetail");

  poolDetail.innerHTML = `
    <div class="card">
      <div class="card-kicker">PORRA PRIVADA</div>
      <h1>${escapeHtml(pool.name)}</h1>

      <p>
        Competición:
        <strong>${escapeHtml(pool.competitions?.name || "Sin competición")}</strong>
      </p>

      <p>Código para invitar amigos:</p>
      <span class="code big-code">${escapeHtml(pool.invite_code)}</span>

      <p>${statusHtml}</p>

      <p class="muted">
        Cierre de apuestas: ${escapeHtml(formatDate(pool.predictions_close_at))}
      </p>

      <div class="action-row">
        <button id="goBetBtn" class="primary-btn" type="button">
          ${closed ? "Ver formulario bloqueado" : "Hacer / modificar apuesta"}
        </button>

        <button id="goMyBetBtn" class="secondary-btn" type="button">
          Mi apuesta
        </button>

        <button id="goRankingBtn" class="secondary-btn" type="button">
          Ranking
        </button>

        ${
          isCurrentPoolAdmin()
            ? `<button id="goAdminResultsBtn" class="ghost-btn" type="button">Admin resultados</button>`
            : ""
        }
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-kicker">MIEMBROS</div>
      <ul>${memberRows || "<li>No hay miembros.</li>"}</ul>
    </div>
  `;

  $("goBetBtn").addEventListener("click", () => {
    openBet(pool.id);
  });

  $("goMyBetBtn").addEventListener("click", () => {
    openMyBet(pool.id);
  });

  $("goRankingBtn").addEventListener("click", () => {
    openRanking(pool.id);
  });

  $("goAdminResultsBtn")?.addEventListener("click", () => {
    openAdminResults(pool.id);
  });

  show("poolView");
}

async function openRanking(poolId) {
  const pool = currentPool?.id === poolId ? currentPool : await fetchPool(poolId);
  currentPool = pool;

  const { data: rankingRows, error } = await sb
    .from("scores")
    .select("user_id, total_points, match_points, top_scorer_points, exact_count, sign_count, profiles:user_id(display_name)")
    .eq("pool_id", pool.id)
    .order("total_points", { ascending: false })
    .order("match_points", { ascending: false });

  if (error) {
    console.error("Ranking error:", error);
    toast(error.message);
    return;
  }

  const rows = (rankingRows || [])
    .map((row, index) => {
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(row.profiles?.display_name || "Usuario")}</td>
          <td><strong>${Number(row.total_points || 0)}</strong></td>
          <td>${Number(row.match_points || 0)}</td>
          <td>${Number(row.top_scorer_points || 0)}</td>
          <td>${Number(row.exact_count || 0)}</td>
          <td>${Number(row.sign_count || 0)}</td>
        </tr>
      `;
    })
    .join("");

  $("rankingContent").innerHTML = `
    <div class="card">
      <div class="card-kicker">RANKING</div>
      <h1>${escapeHtml(pool.name)}</h1>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Usuario</th>
              <th>Total</th>
              <th>Partidos</th>
              <th>Pichichi</th>
              <th>Exactos</th>
              <th>Signos</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="7">Todavía no hay puntuaciones calculadas.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  show("rankingView");
}

async function openAdminResults(poolId) {
  const pool = currentPool?.id === poolId ? currentPool : await fetchPool(poolId);
  currentPool = pool;

  if (!isCurrentPoolAdmin()) {
    toast("Solo owner/admin puede actualizar resultados.");
    return;
  }

  const [{ data: matches, error: matchesError }, { data: players, error: playersError }] =
    await Promise.all([
      sb
        .from("matches")
        .select("id, home_goals, away_goals, status, home:home_team_id(name), away:away_team_id(name)")
        .eq("competition_id", pool.competition_id)
        .order("kickoff", { ascending: true }),
      sb
        .from("players")
        .select("id, name, goals, is_top_scorer, team:team_id(name)")
        .eq("competition_id", pool.competition_id)
        .order("goals", { ascending: false })
    ]);

  if (matchesError || playersError) {
    console.error("Admin resultados error:", { matchesError, playersError });
    toast(matchesError?.message || playersError?.message || "Error cargando datos");
    return;
  }

  const matchRows = (matches || [])
    .map(
      (match) => `
      <tr data-match-id="${match.id}">
        <td>${escapeHtml(match.home?.name || "Local")} - ${escapeHtml(match.away?.name || "Visitante")}</td>
        <td><input class="score-input admin-home" type="number" min="0" max="30" value="${match.home_goals ?? ""}" /></td>
        <td><input class="score-input admin-away" type="number" min="0" max="30" value="${match.away_goals ?? ""}" /></td>
        <td>${escapeHtml(match.status || "pending")}</td>
      </tr>
    `
    )
    .join("");

  const playerRows = (players || [])
    .map(
      (player) => `
      <tr data-player-id="${player.id}">
        <td>${escapeHtml(player.name)}</td>
        <td>${escapeHtml(player.team?.name || "")}</td>
        <td><input class="score-input admin-goals" type="number" min="0" max="30" value="${player.goals ?? 0}" /></td>
        <td>${player.is_top_scorer ? "✅" : "—"}</td>
      </tr>
    `
    )
    .join("");

  $("adminResultsContent").innerHTML = `
    <div class="card">
      <div class="card-kicker">ADMIN RESULTADOS</div>
      <h1>${escapeHtml(pool.name)}</h1>
      <p class="muted">Actualiza marcadores reales y goles de jugadores. Al guardar, se recalcula el ranking.</p>
      <button id="saveAdminResultsBtn" class="primary-btn" type="button">Guardar resultados</button>
    </div>
    <div class="card" style="margin-top:18px">
      <h2>Partidos</h2>
      <div class="table-wrap"><table><thead><tr><th>Partido</th><th>Local</th><th>Visitante</th><th>Status</th></tr></thead><tbody>${matchRows}</tbody></table></div>
    </div>
    <div class="card" style="margin-top:18px">
      <h2>Goles de jugadores</h2>
      <div class="table-wrap"><table><thead><tr><th>Jugador</th><th>Equipo</th><th>Goles</th><th>Top scorer</th></tr></thead><tbody>${playerRows}</tbody></table></div>
    </div>
  `;

  $("saveAdminResultsBtn").addEventListener("click", () => saveAdminResults(pool));
  show("adminResultsView");
}

async function saveAdminResults(pool) {
  if (!isCurrentPoolAdmin()) {
    toast("No autorizado.");
    return;
  }

  const matchRows = Array.from(document.querySelectorAll("tr[data-match-id]"));
  const playerRows = Array.from(document.querySelectorAll("tr[data-player-id]"));

  async function runRpcFallback(calls) {
    let lastError = null;
    for (const call of calls) {
      const { error } = await sb.rpc(call.fn, call.args);
      if (!error) return null;
      lastError = error;
      if (error.code !== "PGRST202") return error;
    }
    return lastError;
  }

  for (const row of matchRows) {
    const home = row.querySelector(".admin-home").value;
    const away = row.querySelector(".admin-away").value;

    if (home === "" || away === "") continue;

    const matchId = row.dataset.matchId;
    const error = await runRpcFallback([
      { fn: "update_match_result", args: { match_uuid: matchId, home_score: Number(home), away_score: Number(away) } },
      { fn: "update_match_result", args: { p_match_uuid: matchId, p_home_score: Number(home), p_away_score: Number(away) } },
      { fn: "update_match_result", args: { match_id: matchId, home_goals: Number(home), away_goals: Number(away) } }
    ]);

    if (error) {
      console.error("update_match_result error:", error);
      if (error.code === "PGRST202") {
        toast("Falta crear/actualizar la función SQL update_match_result en Supabase (schema cache). Ejecuta supabase_phase3.sql y recarga.");
      } else {
        toast(error.message);
      }
      return;
    }
  }

  for (const row of playerRows) {
    const goals = row.querySelector(".admin-goals").value;

    if (goals === "") continue;

    const { error } = await sb.rpc("update_player_goals", {
      player_uuid: row.dataset.playerId,
      goals_count: Number(goals)
    });

    if (error) {
      console.error("update_player_goals error:", error);
      toast(error.message);
      return;
    }
  }

  const { error: recalcError } = await sb.rpc("recalculate_pool_scores", {
    pool_uuid: pool.id
  });

  if (recalcError) {
    console.error("recalculate_pool_scores error:", recalcError);
    toast(recalcError.message);
    return;
  }

  toast("Resultados guardados y ranking recalculado.");
  await openRanking(pool.id);
}

async function openBet(poolId) {
  const pool = currentPool?.id === poolId ? currentPool : await fetchPool(poolId);
  currentPool = pool;

  if (!pool.competition_id) {
    toast(
      "Esta porra no tiene competición asignada. Crea una porra nueva o asigna Eurocopa Demo en Supabase."
    );
    return;
  }

  const closed = isPoolClosed(pool);

  const [
    { data: matches, error: matchesError },
    { data: players, error: playersError },
    { data: existingPredictions, error: predictionsError },
    { data: existingPick, error: pickError }
  ] = await Promise.all([
    sb
      .from("matches")
      .select("*, home:home_team_id(name), away:away_team_id(name)")
      .eq("competition_id", pool.competition_id)
      .order("kickoff", { ascending: true }),

    sb
      .from("players")
      .select("*, team:team_id(name)")
      .eq("competition_id", pool.competition_id)
      .order("name", { ascending: true }),

    sb
      .from("predictions")
      .select("*")
      .eq("pool_id", pool.id)
      .eq("user_id", currentUser.id),

    sb
      .from("top_scorer_picks")
      .select("*")
      .eq("pool_id", pool.id)
      .eq("user_id", currentUser.id)
      .maybeSingle()
  ]);

  if (matchesError) {
    console.error("Matches error:", matchesError);
    toast(matchesError.message);
    return;
  }

  if (playersError) {
    console.error("Players error:", playersError);
    toast(playersError.message);
    return;
  }

  if (predictionsError) {
    console.error("Predictions error:", predictionsError);
    toast(predictionsError.message);
    return;
  }

  if (pickError) {
    console.error("Pick error:", pickError);
  }

  const predByMatch = new Map(
    (existingPredictions || []).map((prediction) => [
      prediction.match_id,
      prediction
    ])
  );

  const playerOptions = (players || [])
    .map((player) => {
      return `
        <option value="${player.id}" ${
        existingPick?.player_id === player.id ? "selected" : ""
      }>
          ${escapeHtml(player.name)} (${escapeHtml(player.team?.name || "Equipo")})
        </option>
      `;
    })
    .join("");

  const matchRows = (matches || [])
    .map((match) => {
      const pred = predByMatch.get(match.id);

      return `
        <div class="match-row" data-match-id="${match.id}">
          <div class="team-home">${escapeHtml(match.home?.name || "Local")}</div>

          <input
            class="score-input home-score"
            type="number"
            min="0"
            max="30"
            inputmode="numeric"
            value="${pred?.home_goals ?? ""}"
            ${closed ? "disabled" : ""}
          />

          <div class="vs">-</div>

          <input
            class="score-input away-score"
            type="number"
            min="0"
            max="30"
            inputmode="numeric"
            value="${pred?.away_goals ?? ""}"
            ${closed ? "disabled" : ""}
          />

          <div class="team-away">${escapeHtml(match.away?.name || "Visitante")}</div>
        </div>
      `;
    })
    .join("");

  const betContent = $("betContent");

  betContent.innerHTML = `
    <div class="card">
      <div class="card-kicker">BOLETO DE MISIÓN</div>
      <h1>Hacer apuesta</h1>

      <p>
        ${
          closed
            ? "Las apuestas están cerradas. Puedes consultar tu boleto, pero no modificarlo."
            : "Rellena todos los partidos y elige tu pichichi. Puedes modificarlo hasta el cierre."
        }
      </p>

      <p class="muted">Cierre: ${escapeHtml(formatDate(pool.predictions_close_at))}</p>

      <label>Tu pichichi</label>
      <select id="topScorerSelect" ${closed ? "disabled" : ""}>
        <option value="">Selecciona jugador...</option>
        ${playerOptions}
      </select>
    </div>

    <form id="betForm" class="card" style="margin-top:18px">
      <div class="card-kicker">PARTIDOS</div>
      <div class="match-list">${matchRows}</div>

      ${
        closed
          ? ""
          : `<button class="primary-btn full" type="submit">Guardar apuesta</button>`
      }
    </form>
  `;

  if (!closed) {
    $("betForm").addEventListener("submit", (event) => {
      saveBet(event, pool, matches || []);
    });
  }

  show("betView");
}

async function saveBet(event, pool, matches) {
  event.preventDefault();

  if (isPoolClosed(pool)) {
    toast("Las apuestas ya están cerradas.");
    return;
  }

  const topScorerId = $("topScorerSelect").value;

  if (!topScorerId) {
    toast("Te falta elegir pichichi.");
    return;
  }

  const rows = Array.from(document.querySelectorAll(".match-row"));
  const predictions = [];

  for (const row of rows) {
    const matchId = row.dataset.matchId;
    const homeRaw = row.querySelector(".home-score").value;
    const awayRaw = row.querySelector(".away-score").value;

    if (homeRaw === "" || awayRaw === "") {
      toast("Te faltan partidos por completar.");
      return;
    }

    predictions.push({
      pool_id: pool.id,
      user_id: currentUser.id,
      match_id: matchId,
      home_goals: Number(homeRaw),
      away_goals: Number(awayRaw),
      updated_at: new Date().toISOString()
    });
  }

  if (predictions.length !== matches.length) {
    toast("El boleto no está completo.");
    return;
  }

  const { error: predError } = await sb
    .from("predictions")
    .upsert(predictions, {
      onConflict: "pool_id,user_id,match_id"
    });

  if (predError) {
    console.error("Save predictions error:", predError);
    toast(predError.message);
    return;
  }

  const { error: pickError } = await sb
    .from("top_scorer_picks")
    .upsert(
      {
        pool_id: pool.id,
        user_id: currentUser.id,
        player_id: topScorerId,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "pool_id,user_id"
      }
    );

  if (pickError) {
    console.error("Save pick error:", pickError);
    toast(pickError.message);
    return;
  }

  const { error: entryError } = await sb
    .from("pool_entries")
    .upsert(
      {
        pool_id: pool.id,
        user_id: currentUser.id,
        status: "submitted",
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "pool_id,user_id"
      }
    );

  if (entryError) {
    console.error("Save entry error:", entryError);
    toast(entryError.message);
    return;
  }

  $("betContent").innerHTML = `
    <div class="card">
      <div class="card-kicker">APUESTA GUARDADA</div>
      <h1>✅ Tu apuesta está lista</h1>

      <p>
        Tu boleto ha quedado guardado correctamente. Puedes consultarlo cuando quieras
        y modificarlo hasta que cierre el plazo.
      </p>

      <p class="muted">
        Cierre de apuestas: ${escapeHtml(formatDate(pool.predictions_close_at))}
      </p>

      <div class="action-row">
        <button id="viewMyBetAfterSaveBtn" class="primary-btn" type="button">
          Ver mi apuesta
        </button>

        <button id="editAfterSaveBtn" class="secondary-btn" type="button">
          Modificar apuesta
        </button>
      </div>
    </div>
  `;

  $("viewMyBetAfterSaveBtn").addEventListener("click", () => {
    openMyBet(pool.id);
  });

  $("editAfterSaveBtn").addEventListener("click", () => {
    openBet(pool.id);
  });
}

async function openMyBet(poolId) {
  const pool = currentPool?.id === poolId ? currentPool : await fetchPool(poolId);
  currentPool = pool;

  if (!pool.competition_id) {
    toast("Esta porra no tiene competición asignada.");
    return;
  }

  const [
    { data: matches, error: matchesError },
    { data: predictions, error: predictionsError },
    { data: pick, error: pickError },
    { data: topPlayers, error: topPlayersError }
  ] = await Promise.all([
    sb
      .from("matches")
      .select("*, home:home_team_id(name), away:away_team_id(name)")
      .eq("competition_id", pool.competition_id)
      .order("kickoff", { ascending: true }),

    sb
      .from("predictions")
      .select("*")
      .eq("pool_id", pool.id)
      .eq("user_id", currentUser.id),

    sb
      .from("top_scorer_picks")
      .select("*, player:player_id(name, goals, team:team_id(name))")
      .eq("pool_id", pool.id)
      .eq("user_id", currentUser.id)
      .maybeSingle(),

    sb
      .from("players")
      .select("*, team:team_id(name)")
      .eq("competition_id", pool.competition_id)
      .order("goals", { ascending: false })
      .limit(5)
  ]);

  if (matchesError) {
    console.error("My bet matches error:", matchesError);
    toast(matchesError.message);
    return;
  }

  if (predictionsError) {
    console.error("My bet predictions error:", predictionsError);
    toast(predictionsError.message);
    return;
  }

  if (pickError) {
    console.error("My bet pick error:", pickError);
  }

  if (topPlayersError) {
    console.error("Top players error:", topPlayersError);
  }

  const predByMatch = new Map(
    (predictions || []).map((prediction) => [
      prediction.match_id,
      prediction
    ])
  );

  let totalKnownPoints = 0;

  const rows = (matches || [])
    .map((match) => {
      const pred = predByMatch.get(match.id);

      if (!pred) {
        return `
          <tr>
            <td>${escapeHtml(match.home?.name)} - ${escapeHtml(match.away?.name)}</td>
            <td>Sin apuesta</td>
            <td>${realScoreText(match)}</td>
            <td class="result-bad">-</td>
          </tr>
        `;
      }

      const score = scorePrediction(pred, match);

      if (score.points !== null) {
        totalKnownPoints += score.points;
      }

      return `
        <tr>
          <td>${escapeHtml(match.home?.name)} - ${escapeHtml(match.away?.name)}</td>
          <td>${pred.home_goals} - ${pred.away_goals}</td>
          <td>${realScoreText(match)}</td>
          <td class="${score.cls}">
            ${score.points === null ? "Pendiente" : "+" + score.points + " · " + score.label}
          </td>
        </tr>
      `;
    })
    .join("");

  const topRows = (topPlayers || [])
    .map((player, index) => {
      const isMine = pick?.player_id === player.id;

      return `
        <tr>
          <td>${index + 1}</td>
          <td>
            <strong>${escapeHtml(player.name)}</strong>
            ${isMine ? " ← Tu elección" : ""}
          </td>
          <td>${escapeHtml(player.team?.name || "")}</td>
          <td>${player.goals}</td>
        </tr>
      `;
    })
    .join("");

  $("myBetContent").innerHTML = `
    <div class="card">
      <div class="card-kicker">MI APUESTA</div>
      <h1>Mi apuesta vs resultado real</h1>

      <p class="muted">
        Puntos de partidos ya resueltos: <strong>${totalKnownPoints}</strong>
      </p>

      <div class="action-row">
        ${
          isPoolClosed(pool)
            ? ""
            : `<button id="editFromMyBetBtn" class="secondary-btn" type="button">
                Modificar antes del cierre
              </button>`
        }
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-kicker">PICHICHI</div>
      <h2>Tu elección</h2>

      <p>
        ${
          pick?.player
            ? `<strong>${escapeHtml(pick.player.name)}</strong> (${escapeHtml(
                pick.player.team?.name || "Equipo"
              )}) — ${pick.player.goals} goles`
            : "Todavía no has elegido pichichi."
        }
      </p>

      <h2>Top 5 pichichis actuales</h2>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Jugador</th>
              <th>Equipo</th>
              <th>Goles</th>
            </tr>
          </thead>
          <tbody>
            ${topRows || `<tr><td colspan="4">Sin datos</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-kicker">PARTIDOS</div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Partido</th>
              <th>Tu apuesta</th>
              <th>Resultado real</th>
              <th>Puntos</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;

  const editBtn = $("editFromMyBetBtn");

  if (editBtn) {
    editBtn.addEventListener("click", () => {
      openBet(pool.id);
    });
  }

  show("myBetView");
}

async function registerUser(event) {
  event.preventDefault();

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
  await bootApp();
}

async function loginUser(event) {
  event.preventDefault();

  console.log("=== LOGIN START ===");
  toast("Intentando iniciar sesión...");

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  try {
    const { data, error } = await sb.auth.signInWithPassword({
      email,
      password
    });

    console.log("=== LOGIN RESPONSE ===", { data, error });

    if (error) {
      alert("Error login: " + error.message);
      toast(error.message);
      return;
    }

    if (!data.session || !data.user) {
      alert("Login correcto, pero Supabase no devolvió sesión.");
      return;
    }

    currentUser = data.user;

    console.log("=== USER SET ===", currentUser.email, currentUser.id);

    const profile = await ensureProfileForCurrentUser();

    console.log("=== PROFILE QUERY ===", profile);

    if (!profile) {
      alert("Login correcto, pero no se pudo cargar o crear perfil en public.profiles para este usuario.");
      return;
    }

    currentProfile = profile;

    console.log("=== LOADING DASHBOARD ===");

    toast("Login correcto.");
    await loadDashboard();

    console.log("=== DASHBOARD LOADED ===");
  } catch (err) {
    console.error("=== LOGIN FATAL ERROR ===", err);
    alert("Error inesperado: " + err.message);
  }
}

async function logoutUser() {
  await sb.auth.signOut();

  currentUser = null;
  currentProfile = null;
  currentPool = null;

  show("landingView");
}

async function createPool(event) {
  event.preventDefault();

  const name = $("poolName").value.trim();
  const competitionId = $("competitionSelect").value;

  if (name.length < 3) {
    toast("El nombre de la porra es demasiado corto.");
    return;
  }

  if (!competitionId) {
    toast("Selecciona una competición.");
    return;
  }

  const { data, error } = await sb.rpc("create_pool_with_owner", {
    pool_name: name,
    competition_uuid: competitionId
  });

  if (error) {
    console.error("Create pool error:", error);
    toast(error.message);
    return;
  }

  $("poolName").value = "";

  toast(`Porra creada. Código: ${data.invite_code}`);

  await renderPools();
  await openPool(data.id);
}

async function joinPool(event) {
  event.preventDefault();

  const code = cleanCode($("joinCode").value);

  if (!code) {
    toast("Introduce un código.");
    return;
  }

  const { data, error } = await sb.rpc("join_pool_by_code", {
    code_input: code
  });

  if (error) {
    console.error("Join pool error:", error);
    toast(error.message);
    return;
  }

  $("joinCode").value = "";

  toast("Ya formas parte de la porra.");

  await renderPools();
  await openPool(data);
}

const missionAudio = new Audio(
  "https://rdoivmucgucouauyqdos.supabase.co/storage/v1/object/public/naojaguar/30.1s%20Recording%20(May%2020%20@%2011_39%20PM).mp3"
);
missionAudio.loop = true;
missionAudio.volume = 0.45;

function startMissionSound() {
  const soundBtn = $("soundBtn");

  if (!missionAudio.paused) {
    stopMissionSound();
    return;
  }

  missionAudio.currentTime = 0;
  missionAudio
    .play()
    .then(() => {
      if (soundBtn) {
        soundBtn.textContent = "🔇 Apagar modo misión";
      }
    })
    .catch((error) => {
      console.error("Mission audio play error:", error);
      toast("No se pudo reproducir el audio de misión.");
    });
}

function stopMissionSound() {
  missionAudio.pause();
  missionAudio.currentTime = 0;

  const soundBtn = $("soundBtn");

  if (soundBtn) {
    soundBtn.textContent = "🔊 Activar modo misión";
  }
}

function bindEvents() {
  $("showRegisterBtn")?.addEventListener("click", showRegister);
  $("showLoginBtn")?.addEventListener("click", showLogin);
  $("goLoginBtn")?.addEventListener("click", showLogin);
  $("goRegisterBtn")?.addEventListener("click", showRegister);

  $("registerForm")?.addEventListener("submit", registerUser);
  $("loginForm")?.addEventListener("submit", loginUser);
  $("logoutBtn")?.addEventListener("click", logoutUser);
  $("createPoolForm")?.addEventListener("submit", createPool);
  $("joinPoolForm")?.addEventListener("submit", joinPool);

  $("backDashboardBtn")?.addEventListener("click", loadDashboard);

  $("backPoolBtn")?.addEventListener("click", () => {
    if (currentPool) openPool(currentPool.id);
    else loadDashboard();
  });

  $("backPoolFromMyBetBtn")?.addEventListener("click", () => {
    if (currentPool) openPool(currentPool.id);
    else loadDashboard();
  });

  $("backPoolFromRankingBtn")?.addEventListener("click", () => {
    if (currentPool) openPool(currentPool.id);
    else loadDashboard();
  });

  $("backPoolFromAdminBtn")?.addEventListener("click", () => {
    if (currentPool) openPool(currentPool.id);
    else loadDashboard();
  });

  $("soundBtn")?.addEventListener("click", startMissionSound);
}

sb.auth.onAuthStateChange((event, session) => {
  console.log("Auth state changed:", event, session);

  if (event === "SIGNED_IN" && session?.user) {
    currentUser = session.user;
    ensureProfileForCurrentUser()
      .then((profile) => {
        if (!profile) return;
        currentProfile = profile;
        return loadDashboard();
      })
      .catch((error) => {
        console.error("SIGNED_IN bootstrap error:", error);
      });
  }

  if (event === "SIGNED_OUT") {
    currentUser = null;
    currentProfile = null;
    currentPool = null;
    show("landingView");
  }
});

bindEvents();
bootApp();
