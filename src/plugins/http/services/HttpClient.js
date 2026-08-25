const fs = require("node:fs/promises");
const path = require("node:path");
class HttpClient {

    static async request(url, options = {}) {

        const {
            timeout = 30000,
            ...fetchOptions
        } = options;

        const controller = new AbortController();

        const timer = setTimeout(() => {
            controller.abort();
        }, timeout);

        try {

            // Auto JSON body
            if (
                fetchOptions.body &&
                typeof fetchOptions.body === "object" &&
                !(fetchOptions.body instanceof FormData)
            ) {

                fetchOptions.headers = {
                    "Content-Type": "application/json",
                    ...(fetchOptions.headers || {})
                };

                fetchOptions.body = JSON.stringify(fetchOptions.body);

            }

            const response = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal
            });

            clearTimeout(timer);

            const contentType = response.headers.get("content-type") || "";

            const hasBody =
                fetchOptions.method !== "HEAD" &&
                response.status !== 204 &&
                response.status !== 205 &&
                response.status !== 304;

            let data = null;

            if (hasBody) {

                if (contentType.includes("application/json")) {
                    data = await response.json();
                } else {
                    data = await response.text();
                }

            }

            return {
                success: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                data
            };

        } catch (error) {

            clearTimeout(timer);

            return {
                success: false,
                error: error.message
            };

        }

    }

    static get(url, options = {}) {

        return this.request(url, {
            method: "GET",
            ...options
        });

    }

    static post(url, options = {}) {

        return this.request(url, {
            method: "POST",
            ...options
        });

    }

    static put(url, options = {}) {

        return this.request(url, {
            method: "PUT",
            ...options
        });

    }

    static patch(url, options = {}) {

        return this.request(url, {
            method: "PATCH",
            ...options
        });

    }

    static delete(url, options = {}) {

        return this.request(url, {
            method: "DELETE",
            ...options
        });

    }

    static head(url, options = {}) {

        return this.request(url, {
            method: "HEAD",
            ...options
        });

    }

    static async stream(url, options = {}) {

    const {
        timeout = 30000,
        ...fetchOptions
    } = options;

    const controller = new AbortController();

    const timer = setTimeout(() => {

        controller.abort();

    }, timeout);

    try {

        if (
            fetchOptions.body &&
            typeof fetchOptions.body === "object" &&
            !(fetchOptions.body instanceof FormData)
        ) {

            fetchOptions.headers = {

                "Content-Type": "application/json",

                ...(fetchOptions.headers || {})

            };

            fetchOptions.body =
                JSON.stringify(fetchOptions.body);

        }

        const response = await fetch(url, {

            method: "POST",   // ⭐ tambahkan ini

            ...fetchOptions,

            signal: controller.signal

        });

        clearTimeout(timer);

        if (!response.ok) {

            throw new Error(

                `${response.status} ${response.statusText}`

            );

        }

        return response.body;

    }

    catch (error) {

        clearTimeout(timer);

        throw error;

    }

}
static async download(url, output, options = {}) {

    const {
        timeout = 30000,
        headers = {}
    } = options;

    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, timeout);

    try {

        const response = await fetch(url, {
            method: "GET",
            headers,
            signal: controller.signal
        });

        clearTimeout(timer);

        if (!response.ok) {

            return {
                success: false,
                status: response.status,
                statusText: response.statusText
            };

        }

        const buffer = Buffer.from(await response.arrayBuffer());

        await fs.mkdir(path.dirname(output), {
            recursive: true
        });

        await fs.writeFile(output, buffer);

        return {
            success: true,
            status: response.status,
            statusText: response.statusText,
            path: output,
            size: buffer.length
        };

    } catch (error) {

        clearTimeout(timer);

        return {
            success: false,
            error: error.message
        };

    }
    

}
}

module.exports = HttpClient;