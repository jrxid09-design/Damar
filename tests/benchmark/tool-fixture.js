/**
 * Registry sintetis untuk benchmark — ±120 tool yang mencerminkan
 * domain nyata Damar (nama & deskripsi bergaya sama dengan registry
 * asli), termasuk tiga tool MCP dinamis yang tidak dikenal pipeline.
 */

const NATIVE = [
    ["memory_remember", "Store a fact into long-term memory"],
    ["memory_recall", "Recall long-term memories relevant to a query"],
    ["memory_forget", "Forget a memory entry by id or topic"],
    ["memory_related", "Explore relations between remembered entities"],
    ["memory_entities", "List entities known to Damar"],
    ["memory_documents", "List stored documents in memory"],
    ["system.time.currentTime", "Get the current date and time"],
    ["weather.currentWeather", "Get current weather for a city"],
    ["filesystem.readFile", "Read a text file from disk"],
    ["filesystem.writeFile", "Write content to a file on disk"],
    ["filesystem.listDirectory", "List entries of a directory"],
    ["filesystem.deleteFile", "Delete a file from disk"],
    ["http.get", "Perform HTTP GET request to a URL"],
    ["http.post", "Perform HTTP POST request to a URL"],
    ["http.download", "Download a file from a URL"],
    ["browse", "Open a web page in a browser and read its content"],
    ["calculator.calculate", "Evaluate a math expression"],
    ["home_control", "Control a home device: turn on/off, toggle, set temperature"],
    ["home_devices", "List home devices and their states"],
    ["home_state", "Summary of home state: which devices are on"],
    ["home_analyze", "Analyze home energy usage patterns"],
    ["device_on", "Turn a home device on"],
    ["device_off", "Turn a home device off"],
    ["scene_activate", "Activate a Home Assistant scene"],
    ["set_temperature", "Set target temperature of a thermostat or AC"],
    ["see_camera", "Look at a registered camera and answer about its view"],
    ["list_cameras", "List registered cameras"],
    ["count_people_camera", "Count people visible in a camera view"],
    ["describe_image", "Describe or analyze an image from a URL"],
    ["search_photos", "Search photos in the gallery by query"],
    ["find_people", "Find people in the photo gallery"],
    ["photos_summary", "Summary of the photo gallery"],
    ["send_immich_photo", "Send a gallery photo to a chat"],
    ["send_file", "Send a local file to a chat"],
    ["send_media_url", "Send a media URL to a chat"],
    ["wa_send", "Send a WhatsApp message to a number"],
    ["wa_status", "WhatsApp connection status"],
    ["whatsapp_send_photo", "Send a photo to WhatsApp chat"],
    ["whatsapp_send_document", "Send a document to WhatsApp chat"],
    ["play_youtube", "Play a YouTube video or song by name"],
    ["play_media", "Play a media URL in the console player"],
    ["play_spotify", "Play a Spotify track by URL"],
    ["search_music", "Search for a song by title and artist"],
    ["stop_media", "Stop the current media playback"],
    ["show_image", "Display an image on the console screen"],
    ["show_video", "Display a video on the console screen"],
    ["open_document", "Open a document in a window"],
    ["terminal_run", "Run a command in a persistent terminal"],
    ["terminal_read", "Read recent output of a terminal"],
    ["terminal_list", "List persistent terminals"],
    ["terminal_restart", "Restart a persistent terminal"],
    ["system_health", "System health: CPU, RAM, uptime"],
    ["nas_status", "NAS storage status"],
    ["nas_pools", "NAS pool details"],
    ["goal_run", "Run an autonomous goal until done"],
    ["capability_search", "Search existing capabilities for a requirement"],
    ["skill_build", "Build a new skill in a sandbox"],
    ["tool_exec", "Execute any tool with retry via the tool bus"],
    ["create_tool", "Create a new tool as a draft"],
    ["activate_tool", "Activate a draft tool"],
    ["list_tools", "List currently attached tools"],
    ["tool_info", "Show details of a registered tool"],
    ["opencode_run", "Delegate a coding task to the opencode agent"],
    ["code_graph_query", "Query the code knowledge graph"],
    ["code_definition", "Find definition of a symbol"],
    ["code_references", "Find references of a symbol"],
    ["code_diagnostics", "Run diagnostics on code"],
    ["code_test", "Run tests for a file or suite"],
    ["code_branch", "Create a git branch"],
    ["code_commit", "Commit staged changes with a message"],
    ["code_diff", "Show working tree diff"],
    ["code_review", "Review recent code changes"],
    ["code_rollback", "Rollback last commit"],
    ["show_chart", "Render a price chart on screen"],
    ["crypto_price", "Get current crypto currency price"],
    ["crypto_analyze", "Analyze a crypto trading pair"],
    ["crypto_portfolio", "Show crypto portfolio holdings"],
    ["crypto_positions", "Show open trading positions"],
    ["crypto_prepare_order", "Prepare an order for confirmation"],
    ["crypto_confirm_order", "Confirm a prepared order"],
    ["crypto_set_alert", "Set a crypto price alert"],
    ["crypto_bot_create", "Create a crypto trading bot"],
    ["crypto_bot_list", "List crypto trading bots"],
    ["money_scan", "Scan markets for money-making opportunities"],
    ["money_size", "Size a position by risk budget"],
    ["money_report", "Report realized profit and loss"],
    ["money_log", "Log a trade to the journal"],
    ["voice_status", "Voice runtime status"],
    ["transcribe", "Transcribe an audio file to text"],
    ["tts_speak", "Speak text out loud with TTS"],
    ["self_state", "Show Damar inner state"],
    ["self_reflect", "Save an inner reflection"],
    ["think_deeply", "Think through a hard problem step by step"],
    ["world_describe", "Describe the world model around a topic"],
    ["osint_investigate", "Investigate a subject across sources"],
    ["osint_email", "Look up an email address"],
    ["osint_phone", "Look up a phone number"],
    ["osint_username", "Look up a username across platforms"],
    ["osint_domain", "Look up a domain reputation"],
    ["osint_breach", "Check breach exposure of an identifier"],
    ["kali_run", "Run a command in the Kali Linux arsenal"],
    ["ml_env", "Probe the ML environment: python, torch, cuda"],
    ["ml_run", "Run an ML experiment script"],
    ["android_devices", "List connected Android devices"],
    ["android_screenshot", "Capture Android phone screen"],
    ["android_tap", "Tap Android screen coordinates"],
    ["android_type", "Type text on Android device"],
    ["open_app", "Open a desktop application window"],
    ["desktop_type", "Type text into the focused window"],
    ["captureScreen", "Capture the desktop screen image"],
    // Tool meta disclosure — terdaftar oleh aiRuntimeService di runtime nyata.
    ["tool_search", "Search all Damar capabilities and tools by keyword"]
];

/** Tool MCP eksternal — TIDAK diketahui pipeline sebelumnya. */
const MCP = [
    ["mcp__homey__device_turn_off", "Turn off a smart plug or device via Homey bridge"],
    ["mcp__homey__sensor_temperature_read", "Read temperature sensor values from smart home sensors"],
    ["mcp__gcal__calendar_sync_now", "Synchronize Google Calendar events now"]
];

/** Bangun daftar AITool-like untuk kedua engine seleksi. */
function buildRegistry() {

    const makeTool = ([name, description]) => ({
        name,
        description,
        parameters: { type: "object", properties: {} },
        execute: async () => ({ ok: true })
    });

    return [
        ...NATIVE.map(makeTool),
        ...MCP.map(makeTool)
    ];

}

module.exports = { buildRegistry };

