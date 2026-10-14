/** Decode the public historical-data evidence captured by the isolated mock stream. */
export function summaryRecords(messages) {
    return messages.flatMap((message) =>
        message.content.flatMap((block) => {
            if (block.type !== "text" || !block.text.startsWith("{")) return [];
            const record = JSON.parse(block.text);
            return typeof record.role === "string" && typeof record.type === "string"
                ? [record]
                : [];
        }),
    );
}
