const Damar = require("../src/ai"); // sesuaikan dengan export project-mu

async function main() {

    const ai = new Damar.Builder()

        .provider("openrouter", {

            apiKey: process.env.OPENROUTER_API_KEY

        })

        .defaultModel("openrouter/free")

        .build();

    const response = await ai.chat({

        messages: [

            {

                role: "user",

                content: "Halo"

            }

        ]

    });

    console.log(response.content);

}

main().catch(console.error);