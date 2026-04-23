// Cookie-based storage fallback for environments where Web Storage is unavailable
function createCookieStorage() {
    return {
        getItem(key) {
            const name = encodeURIComponent(key) + "=";
            const parts = document.cookie.split(";");
            for (let part of parts) {
                part = part.trim();
                if (part.startsWith(name)) {
                    return decodeURIComponent(part.substring(name.length));
                }
            }
            return null;
        },
        setItem(key, value) {
            const encodedKey = encodeURIComponent(key);
            const encodedValue = encodeURIComponent(value);
            const maxAgeSeconds = 60 * 60 * 24 * 365; // ~1 year
            document.cookie = `${encodedKey}=${encodedValue}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
        },
        removeItem(key) {
            const encodedKey = encodeURIComponent(key);
            document.cookie = `${encodedKey}=; path=/; max-age=0; samesite=lax`;
        },
    };
}

function createSupabaseStorage() {
    const testKey = "sb_storage_test";
    try {
        // For web reliability, prefer localStorage by default.
        // Allow opting out by setting remember_me = "0".
        let desiredStorage = window.localStorage;
        try {
            const pref = window.localStorage && window.localStorage.getItem("remember_me");
            if (pref === "0") desiredStorage = window.sessionStorage;
        } catch (e) {
            // ignore
        }

        // test the desired storage is available
        desiredStorage.setItem(testKey, "1");
        const ok = desiredStorage.getItem(testKey) === "1";
        desiredStorage.removeItem(testKey);
        if (ok) {
            return desiredStorage;
        }
    } catch (e) {
        console.warn(
            "Desired Web Storage unavailable, using cookie storage for Supabase auth",
            e,
        );
    }
    return createCookieStorage();
}

const SUPABASE_URL = "https://frmntglebkzkfhrqdgbm.supabase.co";
const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZybW50Z2xlYmt6a2ZocnFkZ2JtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MDk5OTcsImV4cCI6MjA4NDQ4NTk5N30.E5H1WFGbgBdFyjUcDE7Hg3ajmxgXeGQyXjQQf3Ie_DA";

// Minimal toast helper (used during early boot failures too)
function showToast(msg, type = "info") {
    const colors = {
        error: "#dc2626",
        success: "#16a34a",
        warn: "#ca8a04",
        info: "#2563eb",
    };
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.style.background = colors[type] || colors.info;
    t.style.display = "block";
    t.style.opacity = "1";
    setTimeout(() => {
        t.style.opacity = "0";
        setTimeout(() => (t.style.display = "none"), 300);
    }, 4000);
}

let db = null;
function initSupabaseClient() {
    const storage = createSupabaseStorage();
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            storage,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true,
        },
    });
}

async function waitForSupabaseSdk({ timeoutMs = 8000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (window.supabase && typeof window.supabase.createClient === "function") return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
        "Supabase SDK didn't load. If you're using tracking protection/ad-blocking, allow cdn.jsdelivr.net, then refresh.",
    );
}

async function ensureDbReady() {
    if (db) return;
    await waitForSupabaseSdk();
    initSupabaseClient();
}

// Initialize client on load (don't hard-crash if the CDN is blocked/delayed)
(async () => {
    try {
        await waitForSupabaseSdk();
        initSupabaseClient();
    } catch (e) {
        console.error(e);
        if (typeof showToast === "function") {
            showToast(e?.message || "App failed to load. Please refresh.", "error");
        }
    }
})();

// ── State ──────────────────────────────────────────────────────────────────
let currentUser = null;
let currentTab = "foss";
let isRegistering = false;
let allTargets = [];
let selectedTarget = null;
let selectedSolutions = [];
let selectedFossTargets = [];
let selectedTargetAlternatives = [];
let dupFlags = { foss: false, target: false };
let selectedTargets = [];

// ── DOM Helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const val = (id) => ($(id) ? $(id).value.trim() : "");
const show = (id) => $(id) && $(id).classList.remove("hidden");
const hide = (id) => $(id) && $(id).classList.add("hidden");

// (showToast is defined above for early-boot errors)

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
    await ensureDbReady();

    if (typeof window !== "undefined" && window.location.hash) {
        const hash = window.location.hash;
        if (hash.includes("access_token=") || hash.includes("refresh_token=") || hash.includes("type=")) {
            try {
                await db.auth.getSession();
            } catch (e) {
                console.warn("OAuth callback session parse failed", e);
            }
            try {
                window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
            } catch (e) {
                // ignore
            }
        }
    }
    try {
        const {
            data: { session },
        } = await db.auth.getSession();
        if (session?.user) await loadUser(session.user);
    } catch (e) {
        console.warn("Failed to get session on init", e);
    }

    db.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
            if (currentUser && currentUser.id === session.user.id) return;
            loadUser(session.user);
        } else {
            // no session
            currentUser = null;
        }
    });

    // Keep sessions warm on platforms where background timers/network get paused.
    setInterval(async () => {
        try {
            await db.auth.getSession();
        } catch (e) {
            // ignore
        }
    }, 5 * 60 * 1000);

    loadImpactStats();
}

async function loadUser(user) {
    currentUser = user;
    $("nav-email").textContent = user.email;
    $("nav-user").classList.replace("hidden", "flex");
    hide("screen-auth");
    show("screen-submit");

    await db.from("admin_users").select("is_active").eq("id", user.id).single();
    // Admin panel link removed from this page.

    const { data: targets } = await db
        .from("targets")
        .select("name, package_name")
        .order("name");
    allTargets = targets || [];

    switchTab("foss");
}

// ── Auth ───────────────────────────────────────────────────────────────────
function toggleRegister() {
    isRegistering = !isRegistering;
    $("auth-btn").textContent = isRegistering ? "Register" : "Sign In";
    $("toggle-register").textContent = isRegistering
        ? "Already have an account? Sign in"
        : "Need an account? Register";
}

// Helper to apply remember preference and reinitialize client before auth calls
function applyRememberPreference() {
    try {
        const rememberCheckbox = $("remember-me");
        if (rememberCheckbox && rememberCheckbox.checked) {
            window.localStorage && window.localStorage.setItem("remember_me", "1");
        } else {
            // explicitly opt-out of persistence
            window.localStorage && window.localStorage.setItem("remember_me", "0");
        }
    } catch (e) {
        // ignore errors reading/writing storage
    }
}

async function login() {
    await ensureDbReady();
    const email = val("auth-email"),
        password = val("auth-password");
    if (!email || !password) return showToast("Enter email and password", "error");

    // Apply remember preference and reinit client so storage will be used accordingly
    applyRememberPreference();

    $("auth-btn").disabled = true;
    $("auth-btn").textContent = "Processing...";

    try {
        const { error } = isRegistering
            ? await db.auth.signUp({
                email,
                password,
                options: {
                    emailRedirectTo:
                        window.location.origin + window.location.pathname,
                },
            })
            : await db.auth.signInWithPassword({ email, password });
        if (error) throw error;

        if (isRegistering) {
            showToast("Registered! Check your email to verify.", "success");
        } else {
            const {
                data: { session },
            } = await db.auth.getSession();
            await loadUser(session.user);
            showToast("Logged in!", "success");
        }
    } catch (e) {
        showToast(e.message || String(e), "error");
    } finally {
        $("auth-btn").disabled = false;
        $("auth-btn").textContent = isRegistering ? "Register" : "Sign In";
    }
}

async function logout() {
    if (!db) initSupabaseClient();
    await db.auth.signOut();
    currentUser = null;
    $("nav-user").classList.replace("flex", "hidden");
    hide("screen-submit");
    show("screen-auth");
    showToast("Logged out");
}

async function loginWithGithub() {
    await ensureDbReady();
    // apply the remember preference first so storage choice is set before the OAuth redirect flow
    applyRememberPreference();

    $("github-btn").disabled = true;
    $("github-btn").innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Redirecting...';
    try {
        await db.auth.signInWithOAuth({
            provider: "github",
            options: {
                redirectTo: window.location.origin + window.location.pathname,
            },
        });
    } catch (e) {
        showToast(e.message || String(e), "error");
        $("github-btn").disabled = false;
        $("github-btn").innerHTML =
            '<i class="fab fa-github text-lg"></i> Continue with GitHub';
    }
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(tab) {
    currentTab = tab;
    // Do NOT reset form fields here so user input is preserved when switching tabs

    ["foss", "target", "linking"].forEach((t) => {
        const btn = $(`tab-${t}`);
        btn.className = `px-5 py-2 rounded-full border font-medium transition-colors ${
            t === tab
                ? "bg-blue-600 text-white border-blue-500"
                : "bg-zinc-900 text-zinc-400 border-zinc-700 hover:bg-zinc-800 hover:text-white"
        }`;
        t === tab ? show(`form-${t}`) : hide(`form-${t}`);
    });

    $("submit-label").textContent =
        tab === "linking" ? "Submit Link Request" : "Submit App";
}

function resetForms() {
    [
        "foss-name",
        "foss-pkg",
        "foss-desc",
        "foss-repo",
        "foss-fdroid",
        "foss-license",
        "target-name",
        "target-pkg",
        "target-desc",
    "target-alt-search",
        "link-target-search",
        "link-sol-search",
    ].forEach((id) => ((document.getElementById(id) || {}).value = ""));
    if ($("target-cat")) $("target-cat").value = "";
    dupFlags = { foss: false, target: false };
    hide("foss-dup-warn");
    hide("target-dup-warn");
    clearTarget();
    selectedSolutions = [];
    selectedFossTargets = [];
    selectedTargetAlternatives = [];
    renderFossTargets();
    renderTargetAlternatives();
    renderSolutionChips();
}

// ── Proprietary Target — Alternatives (FOSS) ──────────────────────────────
function filterTargetAlternatives(q) {
    const dd = $("target-alt-dropdown");
    if (!dd) return;

    const query = (q || "").trim();
    const results =
        !query || query.length < 2
            ? []
            : (allTargets || []).filter(
                  (t) =>
                      (t.name || "")
                          .toLowerCase()
                          .includes(query.toLowerCase()) ||
                      (t.package_name || "")
                          .toLowerCase()
                          .includes(query.toLowerCase()),
              );

    if (!results.length) {
        hide("target-alt-dropdown");
        return;
    }

    dd.innerHTML = results
        .slice(0, 20)
        .map(
            (t) => `
    <button onclick="selectTargetAlternative('${t.package_name}', '${(t.name || t.package_name).replace(/'/g, "&#39;")}')"
        class="w-full text-left px-4 py-3 hover:bg-zinc-700 border-b border-zinc-700/50 last:border-0">
        <div class="font-medium text-white">${t.name || t.package_name}</div>
        <div class="text-xs text-zinc-400">${t.package_name}</div>
    </button>
`,
        )
        .join("");
    show("target-alt-dropdown");
}

function selectTargetAlternative(pkg, name) {
    if (!pkg) return;
    if (selectedTargetAlternatives.find((t) => t.pkg === pkg)) {
        if ($("target-alt-search")) $("target-alt-search").value = "";
        hide("target-alt-dropdown");
        return;
    }
    selectedTargetAlternatives.push({ pkg, name: name || pkg });
    if ($("target-alt-search")) $("target-alt-search").value = "";
    hide("target-alt-dropdown");
    renderTargetAlternatives();
}

function removeTargetAlternative(pkg) {
    selectedTargetAlternatives = selectedTargetAlternatives.filter(
        (t) => t.pkg !== pkg,
    );
    renderTargetAlternatives();
}

function renderTargetAlternatives() {
    const container = $("target-selected-alts");
    if (!container) return;

    if (selectedTargetAlternatives.length === 0) {
        container.innerHTML =
            '<span class="text-sm text-zinc-500 italic">No alternatives selected.</span>';
        return;
    }

    container.innerHTML = selectedTargetAlternatives
        .map(
            (t) => `
                    <span class="inline-flex items-center bg-zinc-800 border border-zinc-700 text-zinc-200 px-2 py-1 rounded text-sm gap-2">
                        <span>${t.name}</span>
                        <button onclick="removeTargetAlternative('${t.pkg}')" class="text-zinc-400 hover:text-white">
                            <i class="fas fa-times"></i>
                        </button>
                    </span>
                `,
        )
        .join("");
}

// ── Pre-fill GitHub ────────────────────────────────────────────────────────
async function prefillFromGithub(githubUrl) {
    if (!githubUrl || !githubUrl.includes("github.com")) return;

    try {
        const urlObj = new URL(githubUrl);
        const pathParts = urlObj.pathname.split("/").filter(Boolean);

        if (pathParts.length < 2) return;

        const owner = pathParts[0];
        const repo = pathParts[1];

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
        if (!response.ok) throw new Error(`API error: ${response.status}`);

        const data = await response.json();

        // Pre-fill only if fields are empty
        const nameInput = $("foss-name");
        const descInput = $("foss-desc");
        const licenseInput = $("foss-license");

        if (!nameInput.value) nameInput.value = data.name;
        if (!descInput.value && data.description) descInput.value = data.description;

        if (
            data.license &&
            (!licenseInput.value || licenseInput.value.trim() === "")
        ) {
            licenseInput.value = data.license.spdx_id || data.license.name;
        }

        showToast("Submission details pre-filled successfully!", "success");
    } catch (error) {
        console.error("Failed to fetch GitHub data:", error);
        showToast(
            "Failed to fetch repo details: " + (error.message || String(error)),
            "error",
        );
    }
}

// ── Duplicate Check ────────────────────────────────────────────────────────
async function checkDuplicate(table, pkg, warnId) {
    const key = table === "solutions" ? "foss" : "target";
    const inputId = key === "foss" ? "foss-pkg" : "target-pkg";

    if (!pkg || pkg.length < 5) {
        dupFlags[key] = false;
        hide(warnId);
        return;
    }

    // Check if it exists as an approved app in the requested table
    const { data } = await db
        .from(table)
        .select("package_name")
        .eq("package_name", pkg)
        .maybeSingle();

    if ($(inputId).value !== pkg) return;

    if (data) {
        dupFlags[key] = true;
        const warningMsg =
            key === "foss"
                ? "This app is already an approved FOSS app."
                : "This app is already an approved proprietary target.";
        const warnEl = $(warnId);
        warnEl.innerHTML = `<i class="fas fa-exclamation-circle mr-1"></i>${warningMsg}`;
        show(warnId);
        return;
    }

    // Check if it exists as a pending submission
    const { data: pendingData } = await db
        .from("user_submissions")
        .select("app_package")
        .eq("app_package", pkg)
        .eq("status", "PENDING")
        .maybeSingle();

    if ($(inputId).value !== pkg) return;

    if (pendingData) {
        dupFlags[key] = true;
        const warnEl = $(warnId);
        warnEl.innerHTML = `<i class="fas fa-exclamation-circle mr-1"></i>This app is already pending review.`;
        show(warnId);
        return;
    }

    dupFlags[key] = false;
    hide(warnId);
}

// ── FOSS — Target Search (Replaces) ────────────────────────────────────────
function filterFossTargets(q) {
    const dd = $("foss-target-dropdown");
    const results =
        !q || q.length < 2
            ? []
            : allTargets.filter(
                  (t) =>
                      (t.name || "").toLowerCase().includes(q.toLowerCase()) ||
                      t.package_name.toLowerCase().includes(q.toLowerCase()),
              );

    if (!results.length) {
        hide("foss-target-dropdown");
        return;
    }

    dd.innerHTML = results
        .map(
            (t) => `
    <button onclick="selectFossTarget('${t.package_name}', '${(t.name || t.package_name).replace(/'/g, "&#39;")}')"
        class="w-full text-left px-4 py-3 hover:bg-zinc-700 border-b border-zinc-700/50 last:border-0">
        <div class="font-medium text-white">${t.name || t.package_name}</div>
        <div class="text-xs text-zinc-400">${t.package_name}</div>
    </button>
`,
        )
        .join("");
    show("foss-target-dropdown");
}

function selectFossTarget(pkg, name) {
    if (selectedFossTargets.find((t) => t.pkg === pkg)) {
        $("foss-target-search").value = "";
        hide("foss-target-dropdown");
        return;
    }

    selectedFossTargets.push({ pkg, name });
    $("foss-target-search").value = "";
    hide("foss-target-dropdown");
    renderFossTargets();
}

function removeFossTarget(pkg) {
    selectedFossTargets = selectedFossTargets.filter((t) => t.pkg !== pkg);
    renderFossTargets();
}

function renderFossTargets() {
    const container = $("foss-selected-targets");
    if (selectedFossTargets.length === 0) {
        container.innerHTML =
            '<span class="text-sm text-zinc-500 italic">No targets selected.</span>';
        return;
    }

    container.innerHTML = selectedFossTargets
        .map(
            (t) => `
                    <span class="inline-flex items-center bg-zinc-800 border border-zinc-700 text-zinc-200 px-2 py-1 rounded text-sm gap-2">
                        <span>${t.name}</span>
                        <button onclick="removeFossTarget('${t.pkg}')" class="text-zinc-400 hover:text-white">
                            <i class="fas fa-times"></i>
                        </button>
                    </span>
                `,
        )
        .join("");
}

// ── Linking — Target Search ────────────────────────────────────────────────
function filterTargets(q) {
    const dd = $("target-dropdown");
    const results =
        !q || q.length < 2
            ? []
            : allTargets.filter(
                  (t) =>
                      (t.name || "").toLowerCase().includes(q.toLowerCase()) ||
                      t.package_name.toLowerCase().includes(q.toLowerCase()),
              );
    if (!results.length) {
        hide("target-dropdown");
        return;
    }

    dd.innerHTML = results
        .map(
            (t) => `
    <button onclick="selectTarget('${t.package_name}', '${(t.name || t.package_name).replace(/'/g, "&#39;")}')"
        class="w-full text-left px-4 py-3 hover:bg-zinc-700 border-b border-zinc-700/50 last:border-0">
        <div class="font-medium text-white">${t.name || t.package_name}</div>
        <div class="text-xs text-zinc-400">${t.package_name}</div>
    </button>
`,
        )
        .join("");
    show("target-dropdown");
}

function selectTarget(pkg, name) {
    // support multiple selected targets (client supports multi-target linking)
    if (typeof selectedTargets === "undefined") selectedTargets = [];
    if (!selectedTargets.includes(pkg)) selectedTargets.push(pkg);
    // clear the search input after selection
    if ($("link-target-search")) $("link-target-search").value = "";
    // show either the single name or a count for multiple selections
    if (selectedTargets.length === 1) {
        $("selected-target-text").textContent = name;
    } else {
        $("selected-target-text").textContent = `${selectedTargets.length} selected`;
    }
    show("selected-target-chip");
    hide("target-dropdown");
}

function clearTarget() {
    // clear multi-target selection
    selectedTargets = [];
    if ($("link-target-search")) $("link-target-search").value = "";
    hide("selected-target-chip");
}

// ── Linking — Solutions Search ─────────────────────────────────────────────
let solTimer;
async function searchSolutions(q) {
    clearTimeout(solTimer);
    if (!q || q.length < 2) {
        hide("sol-dropdown");
        return;
    }
    solTimer = setTimeout(async () => {
        const { data } = await db
            .from("solutions")
            .select("name, package_name")
            .or(`name.ilike.%${q}%,package_name.ilike.%${q}%`)
            .limit(5);
        if (!data?.length) {
            hide("sol-dropdown");
            return;
        }
        $("sol-dropdown").innerHTML = data
            .map(
                (s) => `
        <button onclick="addSolution('${s.package_name}')"
            class="w-full text-left px-4 py-3 hover:bg-zinc-700 border-b border-zinc-700/50 last:border-0 flex justify-between items-center group">
            <div>
                <div class="font-medium text-white">${s.name}</div>
                <div class="text-xs text-zinc-400">${s.package_name}</div>
            </div>
            <i class="fas fa-plus text-blue-500 opacity-0 group-hover:opacity-100"></i>
        </button>
    `,
            )
            .join("");
        show("sol-dropdown");
    }, 250);
}

function addSolution(pkg) {
    if (!selectedSolutions.includes(pkg)) selectedSolutions.push(pkg);
    if ($("link-sol-search")) $("link-sol-search").value = "";
    hide("sol-dropdown");
    renderSolutionChips();
}

function removeSolution(pkg) {
    selectedSolutions = selectedSolutions.filter((p) => p !== pkg);
    renderSolutionChips();
}

function renderSolutionChips() {
    const el = $("selected-solutions");
    if (!el) return;
    el.innerHTML =
        selectedSolutions.length === 0
            ? '<span class="text-sm text-zinc-500 italic">No solutions selected.</span>'
            : selectedSolutions
                  .map(
                      (pkg) => `
        <span class="inline-flex items-center bg-zinc-700 border border-zinc-600 text-zinc-200 px-3 py-1 rounded-lg text-sm gap-2">
            ${pkg}
            <button onclick="removeSolution('${pkg}')" class="text-zinc-400 hover:text-white"><i class="fas fa-times"></i></button>
        </span>
    `,
                  )
                  .join("");
}

// ── Validation ─────────────────────────────────────────────────────────────
function isValid() {
    if (currentTab === "foss")
        return (
            !dupFlags.foss &&
            val("foss-name") &&
            val("foss-pkg") &&
            val("foss-desc") &&
            val("foss-repo") &&
            val("foss-license")
        );
    if (currentTab === "target")
        return !dupFlags.target && val("target-name") && val("target-pkg");
    if (currentTab === "linking") {
        // support backwards compatibility: if selectedTargets exists use its length,
        // otherwise fall back to legacy single selectedTarget variable
        const targetsCount =
            typeof selectedTargets !== "undefined" && Array.isArray(selectedTargets)
                ? selectedTargets.length
                : selectedTarget
                  ? 1
                  : 0;
        return targetsCount > 0 && selectedSolutions.length > 0;
    }
    return false;
}

// ── Submit ─────────────────────────────────────────────────────────────────
async function submit() {
    if (!isValid())
        return showToast("Please fill in all required fields.", "warn");

    show("submit-overlay");
    $("submit-btn").disabled = true;

    try {
        if (currentTab === "linking") {
            // Determine targets to submit: prefer the multi-select array, fall back to legacy single selection
            const targets =
                typeof selectedTargets !== "undefined" &&
                Array.isArray(selectedTargets) &&
                selectedTargets.length > 0
                    ? selectedTargets.slice()
                    : selectedTarget
                      ? [selectedTarget]
                      : [];
            if (!targets.length) throw new Error("No target selected");

            // Prepare batch rows and perform a single batch insert for efficiency
            const rows = targets.map((t) => ({
                submitter_id: currentUser.id,
                proprietary_package: t,
                alternatives: selectedSolutions,
                status: "PENDING",
            }));

            const { data, error } = await db
                .from("user_linking_submissions")
                .insert(rows)
                .select();
            if (error) throw error;
            if (!data?.length) throw new Error("Insertion blocked by RLS.");
            showToast("Linking request(s) submitted!", "success");
        } else {
            const isFoss = currentTab === "foss";
            const payload = {
                submitter_id: currentUser.id,
                app_name: isFoss ? val("foss-name") : val("target-name"),
                app_package: isFoss ? val("foss-pkg") : val("target-pkg"),
                description: isFoss ? val("foss-desc") : val("target-desc"),
                submission_type: isFoss ? "Solution" : "Target",
                status: "PENDING",
            };
            if (isFoss) {
                payload.repo_url = val("foss-repo");
                payload.fdroid_id = val("foss-fdroid") || null;
                payload.license = val("foss-license");
                payload.alternatives = selectedFossTargets.map((t) => t.pkg);
            } else {
                payload.category = $("target-cat").value || null;
                payload.alternatives = selectedTargetAlternatives.map((t) => t.pkg);
            }
            const { data, error } = await db.from("user_submissions").insert(payload).select();
            if (error) throw error;
            if (!data?.length) throw new Error("Insertion blocked by RLS.");
            showToast(`"${payload.app_name}" submitted!`, "success");
        }
        resetForms();
    } catch (e) {
        showToast("Failed: " + (e.message || String(e)), "error");
    } finally {
        hide("submit-overlay");
        $("submit-btn").disabled = false;
    }
}

async function loadImpactStats() {
    try {
        const { data, error } = await db.rpc("get_global_sovereignty_stats");
        if (error) throw error;

        let total = 0;
        const stats = { Sovereign: 0, Transitioning: 0, Captured: 0 };

        data.forEach((row) => {
            stats[row.tier] = row.device_count;
            total += parseInt(row.device_count);
        });

        if (total > 0) {
            // Update Text
            $("total-audited").textContent = total.toLocaleString();
            $("count-sovereign").textContent = stats.Sovereign.toLocaleString();
            $("count-transitioning").textContent =
                stats.Transitioning.toLocaleString();
            $("count-captured").textContent = stats.Captured.toLocaleString();

            // Update Bar Widths (Calculated as %)
            $("bar-sovereign").style.width = (stats.Sovereign / total) * 100 + "%";
            $("bar-transitioning").style.width =
                (stats.Transitioning / total) * 100 + "%";
            $("bar-captured").style.width = (stats.Captured / total) * 100 + "%";

            // Make visible
            show("impact-stats");
        }
    } catch (e) {
        console.error("Impact Stats Error:", e);
    }
}

// Close dropdowns on outside click
document.addEventListener("click", (e) => {
    if (!e.target.closest("#link-target-search") && !e.target.closest("#target-dropdown"))
        hide("target-dropdown");
    if (!e.target.closest("#link-sol-search") && !e.target.closest("#sol-dropdown"))
        hide("sol-dropdown");
    if (
        !e.target.closest("#foss-target-search") &&
        !e.target.closest("#foss-target-dropdown")
    )
        hide("foss-target-dropdown");
});

init();