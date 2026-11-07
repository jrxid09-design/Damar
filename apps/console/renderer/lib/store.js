/**
 * Store minimal berbasis langganan.
 *
 * Cukup untuk aplikasi seukuran ini: satu objek state, satu event
 * "change", dan riwayat metrik untuk sparkline.
 */
class Store extends EventTarget {

    constructor() {

        super();

        this.state = {

            connected: false,

            connecting: false,

            lastError: null,

            settings: {
                daemonUrl: "http://localhost:3000",
                token: "",
                autoConnect: true,
                pollInterval: 5000
            },

            overview: null,

            devices: null,

            /** Riwayat untuk sparkline; dibatasi 40 titik. */
            history: {
                cpu: [],
                memory: []
            },

            logs: [],

            chat: {
                /** Sesi percakapan multi-tab: id → { messages } */
                sessions: {
                    s1: { title: "Sesi 1", messages: [] }
                },
                activeId: "s1",
                streaming: false
            },

            localDaemon: {
                running: false,
                pid: null
            }

        };

    }

    get() {

        return this.state;

    }

    set(patch) {

        Object.assign(this.state, patch);

        this.dispatchEvent(new CustomEvent("change", { detail: this.state }));

        return this.state;

    }

    /** Perbarui satu cabang state tanpa menimpa cabang lain. */
    patch(key, value) {

        this.state[key] = { ...this.state[key], ...value };

        this.dispatchEvent(new CustomEvent("change", { detail: this.state }));

        return this.state;

    }

    pushHistory(cpu, memory) {

        const history = this.state.history;

        history.cpu.push(Number(cpu) || 0);
        history.memory.push(Number(memory) || 0);

        if (history.cpu.length > 40) {
            history.cpu.shift();
            history.memory.shift();
        }

    }

    pushLog(entry) {

        this.state.logs.push(entry);

        // Batasi agar panel log tidak menghabiskan memori di sesi panjang.
        if (this.state.logs.length > 1000) {
            this.state.logs.splice(0, this.state.logs.length - 1000);
        }

        this.dispatchEvent(new CustomEvent("log", { detail: entry }));

    }

    on(event, handler) {

        this.addEventListener(event, handler);

        return () => this.removeEventListener(event, handler);

    }

}

export const store = new Store();
