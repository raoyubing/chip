import { relations, sql } from "drizzle-orm";
import { blob, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  dept: text("dept").notNull(),
  location: text("location").notNull(),
  experience: text("experience").notNull(),
  level: text("level").notNull(),
  salaryRange: text("salary_range").notNull().default("面议"),
  keywords: text("keywords").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  salaryData: text("salary_data"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const candidates = sqliteTable("candidates", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  source: text("source").notNull(),
  score: real("score").notNull(),
  conclusion: text("conclusion").notNull(),
  reason: text("reason").notNull(),
  resumeText: text("resume_text").notNull(),
  uploadTime: text("upload_time").notNull(),
  fileName: text("file_name"),
  fileType: text("file_type"),
  fileSize: integer("file_size"),
  fileBlob: blob("file_blob", { mode: "buffer" }),
  fileObjectKey: text("file_object_key"),
  fileUrl: text("file_url"),
  evaluationJson: text("evaluation_json").notNull().default("{}"),
  interviewPlanJson: text("interview_plan_json").notNull().default("{}"),
  keyPointAnalysis: text("key_point_analysis").notNull().default("[]"),
  interviewQuestions: text("interview_questions").notNull().default("[]"),
  interviewRecommendation: text("interview_recommendation").notNull().default("待定"),
  stageRecommendation: text("stage_recommendation").notNull().default("是"),
  interviewResult: text("interview_result").notNull().default("待定"),
  onboarded: text("onboarded").notNull().default("待入职"),
  reportMonth: text("report_month").notNull().default(""),
  interviewStage: text("interview_stage").notNull().default("初试"),
  interviewReason: text("interview_reason").notNull().default(""),
  reasonTags: text("reason_tags").notNull().default("[]"),
  interviewTimeline: text("interview_timeline").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const voiceAnalyses = sqliteTable("voice_analyses", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  candidateId: text("candidate_id").notNull().references(() => candidates.id, { onDelete: "cascade" }),
  audioName: text("audio_name").notNull(),
  audioType: text("audio_type"),
  audioSize: integer("audio_size"),
  transcript: text("transcript").notNull(),
  summary: text("summary").notNull(),
  jobFitAdvice: text("job_fit_advice").notNull(),
  communicationStrengths: text("communication_strengths").notNull().default("[]"),
  communicationRisks: text("communication_risks").notNull().default("[]"),
  recruiterSuggestions: text("recruiter_suggestions").notNull().default("[]"),
  recruiterReview: text("recruiter_review").notNull().default("[]"),
  recommendation: text("recommendation").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const voiceTranscriptSegments = sqliteTable("voice_transcript_segments", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  candidateId: text("candidate_id").notNull().references(() => candidates.id, { onDelete: "cascade" }),
  segmentIndex: integer("segment_index").notNull(),
  rawTranscript: text("raw_transcript").notNull(),
  normalizedTranscript: text("normalized_transcript").notNull(),
  analysisJson: text("analysis_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const jobsRelations = relations(jobs, ({ many }) => ({
  candidates: many(candidates),
  voiceAnalyses: many(voiceAnalyses),
  voiceTranscriptSegments: many(voiceTranscriptSegments),
}));

export const candidatesRelations = relations(candidates, ({ one, many }) => ({
  job: one(jobs, {
    fields: [candidates.jobId],
    references: [jobs.id],
  }),
  voiceAnalyses: many(voiceAnalyses),
  voiceTranscriptSegments: many(voiceTranscriptSegments),
}));

export const voiceAnalysesRelations = relations(voiceAnalyses, ({ one }) => ({
  job: one(jobs, {
    fields: [voiceAnalyses.jobId],
    references: [jobs.id],
  }),
  candidate: one(candidates, {
    fields: [voiceAnalyses.candidateId],
    references: [candidates.id],
  }),
}));

export const voiceTranscriptSegmentsRelations = relations(voiceTranscriptSegments, ({ one }) => ({
  job: one(jobs, {
    fields: [voiceTranscriptSegments.jobId],
    references: [jobs.id],
  }),
  candidate: one(candidates, {
    fields: [voiceTranscriptSegments.candidateId],
    references: [candidates.id],
  }),
}));
