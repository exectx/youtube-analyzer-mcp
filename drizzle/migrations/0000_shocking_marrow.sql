CREATE TABLE `video_analysis_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`youtube_url` text NOT NULL,
	`question` text NOT NULL,
	`model` text DEFAULT 'gemini-2.5-flash' NOT NULL,
	`result` text,
	`error` text,
	`use_low_resolution` integer DEFAULT false,
	`estimated_duration` integer,
	`processing_time` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
