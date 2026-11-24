import { z } from "zod";
import { Timestamp } from "firebase-admin/firestore";
import { callable } from "../handlers/callable.js";
import { objectId, sourceKey } from "../domain/values.js";
import { sourceSchema } from "../domain/dictionary/source.js";
import { readDeckSource } from "../infrastructure/dictionary/source-reader.js";
import {
  readWord,
  resolveRelease,
} from "../infrastructure/dictionary/word-reader.js";
import { createContentStore } from "../infrastructure/content/store.js";
import { verifyImageReference } from "../services/content/image-access.js";
import { getImageAssetSchema } from "../contracts/content/uploads-inputs.js";
import { command } from "../infrastructure/firebase/commands.js";
import { db } from "../infrastructure/firebase/runtime.js";
import { dayKey, addDays } from "../shared/clock.js";
import { fail } from "../shared/errors.js";
import { parse } from "../shared/validation.js";

export const getPublicDeckSource = callable(
  "getPublicDeckSource",
  async (_actor, raw) => {
    const { source } = parse(z.object({ source: sourceSchema }).strict(), raw);
    if (source.sourceType !== "SYSTEM_DECK") fail("PERMISSION_DENIED");
    const result = await readDeckSource(source);
    return {
      ...result,
      wordRefs: result.words.map((row) => ({
        wordId: row.wordId,
        wordVersion: row.wordVersion,
      })),
    };
  },
  { access: "public" },
);

const images = createContentStore();
export const getPublicImageAsset = callable(
  "getPublicImageAsset",
  async (_actor, raw) => {
    const input = parse(getImageAssetSchema, raw);
    await verifyImageReference(images, input);
    const asset = await images.asset(input.assetId);
    if (
      !asset ||
      asset.state !== "VALIDATED" ||
      (asset.kind && asset.kind !== "IMAGE") ||
      !["image/jpeg", "image/png", "image/webp"].includes(asset.contentType) ||
      !asset.checksum ||
      asset.byteSize <= 0
    )
      fail("NOT_FOUND");
    return {
      assetId: input.assetId,
      ...(await images.imageUrl(asset.storagePath)),
    };
  },
  { access: "public" },
);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const importSchema = z
  .object({
    commandId: objectId,
    remembered: z
      .array(z.object({ wordId: objectId, day: date }).strict())
      .max(100),
    positions: z
      .array(
        z
          .object({
            wordSetId: objectId,
            revisionId: objectId,
            nextWordId: objectId.nullable(),
            completed: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

/** Import only the authenticated learner's own recall/bookmarks; no client scores or other UIDs. */
export const importGuestProgress = callable(
  "importGuestProgress",
  async (actor, raw) => {
    const input = parse(importSchema, raw),
      today = dayKey();
    const release = await resolveRelease(undefined);
    const remembered: typeof input.remembered = [];
    for (const item of input.remembered) {
      const normalized = new Date(item.day + "T12:00:00Z");
      if (
        !Number.isFinite(normalized.getTime()) ||
        normalized.toISOString().slice(0, 10) !== item.day ||
        item.day > today ||
        item.day < addDays(today, -3650)
      )
        fail("VALIDATION_FAILED");
      try {
        await readWord(item.wordId, release.id);
        remembered.push(item);
      } catch (error) {
        if (
          !["WORD_NOT_FOUND", "WORD_UNAVAILABLE"].includes(
            (error as { details?: { code?: string } }).details?.code ?? "",
          )
        )
          throw error;
      }
    }
    const positions: {
      item: (typeof input.positions)[number];
      source: {
        sourceType: "SYSTEM_DECK";
        wordSetId: string;
        revisionId: string;
      };
      words: string[];
    }[] = [];
    for (const item of input.positions) {
      const source = {
        sourceType: "SYSTEM_DECK" as const,
        wordSetId: item.wordSetId,
        revisionId: item.revisionId,
      };
      let content;
      try {
        content = await readDeckSource(source);
      } catch (error) {
        if (
          ["DECK_NOT_FOUND", "DECK_UNAVAILABLE", "REVISION_NOT_FOUND"].includes(
            (error as { details?: { code?: string } }).details?.code ?? "",
          )
        )
          continue;
        throw error;
      }
      if (item.completed !== (item.nextWordId === null))
        fail("VALIDATION_FAILED");
      if (
        item.nextWordId &&
        !content.words.some((word) => word.wordId === item.nextWordId)
      )
        continue;
      positions.push({
        item,
        source,
        words: content.words.map((word) => word.wordId),
      });
    }
    return command(actor, "importGuestProgress", input, async (tx, now) => {
      const root = db.doc(`users/${actor.uid}`);
      const summaryRef = root.collection("dashboard").doc("summary");
      const summary = (await tx.get(summaryRef)).data() ?? {
        learnedCount: 0,
        matchBest: 0,
        listenBest: 0,
        streakAtLastStudyDay: 0,
      };
      const memories = new Map<string, FirebaseFirestore.DocumentSnapshot>();
      for (const item of remembered)
        memories.set(
          item.wordId,
          await tx.get(root.collection("wordProgress").doc(item.wordId)),
        );
      const bookmarks = [];
      for (const entry of positions)
        bookmarks.push({
          ...entry,
          previous: (
            await tx.get(
              root
                .collection("flashcardPositions")
                .doc(sourceKey(entry.source)),
            )
          ).data(),
        });
      let added = 0;
      for (const [wordId, snapshot] of memories) {
        const old = snapshot.data();
        if (old?.everRemembered) continue;
        const item = remembered.find((word) => word.wordId === wordId)!;
        const firstRememberedAt = Timestamp.fromDate(
          new Date(item.day + "T12:00:00+07:00"),
        );
        tx.set(snapshot.ref, {
          ...old,
          wordId,
          version: (old?.version ?? 0) + 1,
          everRemembered: true,
          firstRememberedAt,
          lastRatedAt: old?.lastRatedAt ?? firstRememberedAt,
          lastChoice: old?.lastChoice ?? "REMEMBERED",
        });
        added++;
      }
      for (const { item, source, words, previous } of bookmarks) {
        if (
          previous?.completed ||
          (previous?.source?.revisionId &&
            previous.source.revisionId !== source.revisionId)
        )
          continue;
        const oldIndex = words.indexOf(previous?.nextWordId),
          newIndex = item.completed
            ? words.length
            : words.indexOf(item.nextWordId!);
        if (previous && oldIndex >= newIndex) continue;
        tx.set(root.collection("flashcardPositions").doc(sourceKey(source)), {
          source,
          nextWordId: item.nextWordId,
          completed: item.completed,
          updatedAt: now,
          version: (previous?.version ?? 0) + 1,
        });
      }
      if (added)
        tx.set(summaryRef, {
          ...summary,
          learnedCount: (summary.learnedCount ?? 0) + added,
        });
      return { importedWords: added };
    });
  },
);
