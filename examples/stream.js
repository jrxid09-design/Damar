for await (const chunk of ai.stream({
    messages: [
        {
            role: "user",
            content: "Ceritakan tentang AI."
        }
    ]
})) {

    process.stdout.write(chunk.delta);

}