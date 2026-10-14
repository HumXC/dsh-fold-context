import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { LocalAttachmentStore } from "@deepseek-ai/dsh-attachment-local";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { createUserMessage, createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";

export function png() {
    const chunk = (name, data) => {
        const type = Buffer.from(name);
        let crc = 0xffffffff;
        for (const byte of Buffer.concat([type, data])) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([length, type, data, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
export async function temporaryRoot(t) {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    t.after(async () => {
        if (
            dirname(root) !== tmpdir() ||
            !/^fold-context-test-[A-Za-z0-9]+$/.test(basename(root)) ||
            (await realpath(root)) !== root
        )
            throw new Error("refusing to remove an unverified attachment test root");
        await rm(root, { recursive: true });
    });
    return root;
}
export async function attachmentFixture(t, options = {}) {
    const root = await temporaryRoot(t);
    const f = await fixture(options);
    t.after(f.close);
    const store = new LocalAttachmentStore(f.ctx, { dshHome: root });
    new LocalFileSystem(f.ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 });
    f.llm.fileRequestText = (ref) =>
        `File ${ref.name} (${ref.bytes} bytes): ${store.fileHostPath(ref)}`;
    return { ...f, root, store };
}
export async function admit(f, content, step = 1) {
    const input = createUserMessage({ source: { kind: "user" }, content });
    const decision = await f.ctx.waterfall(
        "agent/pre-step",
        {
            agent: f.agent,
            messages: [input],
            turn: 1,
            step,
            signal: new AbortController().signal,
        },
        async () => ({ kind: "enter", messages: [input] }),
    );
    f.session.append("step/start", { turn: 1, step });
    const events = decision.messages.map((message) =>
        f.session.append("user/message", message, { surfaceOp: "append" }),
    );
    f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            stream: [],
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content: [{ type: "text", text: "Accepted the attachment evidence." }],
            }),
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step });
    f.advanceSteps(step);
    return events[0];
}
export const attachmentSlots = (f) => f.engine.state(f.session).numbering.attachments;
export function outputValue(outcome) {
    const block = outcome.content.find((block) => block.type === "text");
    return JSON.parse(block.text);
}
