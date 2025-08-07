import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";

// Video analysis jobs table
export const videoAnalysisJobs = sqliteTable("video_analysis_jobs", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  status: text("status", { enum: ["pending", "processing", "completed", "failed"] })
    .notNull()
    .default("pending"),
  youtube_url: text("youtube_url").notNull(),
  question: text("question").notNull(),
  model: text("model").notNull().default("gemini-2.5-flash"),
  result: text("result"), // JSON string for large results
  error: text("error"),
  use_low_resolution: integer("use_low_resolution", { mode: "boolean" }).default(false),
  estimated_duration: integer("estimated_duration"), // in seconds
  processing_time: integer("processing_time"), // in seconds
  created_at: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  started_at: integer("started_at", { mode: "timestamp" }),
  completed_at: integer("completed_at", { mode: "timestamp" }),
});

export type VideoAnalysisJob = typeof videoAnalysisJobs.$inferSelect;
export type NewVideoAnalysisJob = typeof videoAnalysisJobs.$inferInsert;