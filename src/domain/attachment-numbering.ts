import { z } from "zod";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { ID_PATTERN } from "./protocol.js";

export const attachmentBlockSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("image"),
        attachment: z.object({
            attachmentId: z.string(),
            mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
            bytes: z.number().int().nonnegative(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            name: z.string().optional(),
            originalDimensions: z
                .object({ width: z.number().int().positive(), height: z.number().int().positive() })
                .optional(),
        }),
        offloaded: z.literal(true).optional(),
    }),
    z.object({
        type: z.literal("file"),
        attachment: z.object({
            attachmentId: z.string(),
            name: z.string(),
            bytes: z.number().int().nonnegative(),
        }),
    }),
]);
export const attachmentSlotSchema = z.object({
    id: z.string().regex(ID_PATTERN),
    kind: z.enum(["image", "file"]),
    ownerId: z.string(),
    role: z.enum(["user", "assistant", "tool"]),
    sourceSeq: z.number().int().nonnegative(),
    currentSeq: z.number().int().nonnegative().nullable(),
    blockIndex: z.number().int().nonnegative(),
    currentBlockIndex: z.number().int().nonnegative().nullable(),
    status: z.enum(["bound", "summarized"]),
    block: attachmentBlockSchema,
    declared: z.boolean(),
});
export type AttachmentSlot = z.infer<typeof attachmentSlotSchema>;
export type AttachmentBlock = Extract<ContentBlock, { type: "image" | "file" }>;
export const isAttachmentBlock = (block: ContentBlock): block is AttachmentBlock =>
    block.type === "image" || block.type === "file";
