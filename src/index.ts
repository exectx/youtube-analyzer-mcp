import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai"; // Using the new @google/genai package (migrated from deprecated @google/generative-ai)
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
  YOUTUBE_API_KEY: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  VIDEO_ANALYSIS_QUEUE: Queue;
};

// Queue message interface
interface QueueMessage {
  jobId: string;
}

interface YouTubeVideoDetails {
  id: string;
  snippet: {
    title: string;
    channelTitle: string;
  };
  contentDetails: {
    duration: string;
  };
}

const app = new Hono<{ Bindings: Bindings }>();

// Helper function to extract video ID from YouTube URL
function extractVideoId(url: string): string | null {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Helper function to parse YouTube duration to seconds
function parseDuration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Get YouTube video details
async function getYouTubeVideoDetails(videoId: string, apiKey: string): Promise<YouTubeVideoDetails | null> {
  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,contentDetails&key=${apiKey}`
    );
    
    if (!response.ok) {
      throw new Error(`YouTube API error: ${response.status}`);
    }
    
    const data = await response.json() as { items: YouTubeVideoDetails[] };
    return data.items?.[0] || null;
  } catch (error) {
    console.error('Error fetching YouTube video details:', error);
    return null;
  }
}

// Process video analysis job
async function processVideoAnalysis(jobId: string, env: Bindings): Promise<void> {
  const db = drizzle(env.DB);
  
  try {
    // Update job status to processing
    await db.update(schema.videoAnalysisJobs)
      .set({ 
        status: "processing",
        started_at: new Date()
      })
      .where(eq(schema.videoAnalysisJobs.id, jobId));

    // Get job details
    const [job] = await db.select()
      .from(schema.videoAnalysisJobs)
      .where(eq(schema.videoAnalysisJobs.id, jobId));

    if (!job) {
      throw new Error('Job not found');
    }

    // Initialize Google GenAI client
    const client = new GoogleGenAI({
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    });

    // Configure model with appropriate settings
    const config: any = {
      responseMimeType: 'text/plain',
    };

    // Add low resolution config for long videos (>1 hour)
    if (job.use_low_resolution) {
      config.mediaResolution = 'MEDIA_RESOLUTION_LOW';
    }

    // Prepare content for video analysis
    const contents = [
      {
        role: 'user' as const,
        parts: [
          {
            fileData: {
              fileUri: job.youtube_url,
              mimeType: 'video/*',
            }
          },
          {
            text: job.question,
          },
        ],
      },
    ];

    // Generate content using streaming
    const response = await client.models.generateContentStream({
      model: job.model,
      config,
      contents,
    });

    let analysisResult = '';
    for await (const chunk of response) {
      if (chunk.text) {
        analysisResult += chunk.text;
      }
    }

    if (!analysisResult.trim()) {
      throw new Error('No analysis could be generated for this video. The video might be private, age-restricted, or unavailable.');
    }

    // Calculate processing time
    const processingTime = job.started_at ? 
      Math.floor((Date.now() - job.started_at.getTime()) / 1000) : 0;

    // Update job with results
    await db.update(schema.videoAnalysisJobs)
      .set({
        status: "completed",
        result: analysisResult,
        completed_at: new Date(),
        processing_time: processingTime
      })
      .where(eq(schema.videoAnalysisJobs.id, jobId));

  } catch (error) {
    // Calculate processing time even for failed jobs
    const [job] = await db.select()
      .from(schema.videoAnalysisJobs)
      .where(eq(schema.videoAnalysisJobs.id, jobId));
    
    const processingTime = job?.started_at ? 
      Math.floor((Date.now() - job.started_at.getTime()) / 1000) : 0;

    let errorMessage = "Unknown error occurred during video analysis";
    
    if (error instanceof Error) {
      // Handle specific Google AI API errors
      if (error.message.includes("API_KEY") || error.message.includes("UNAUTHENTICATED")) {
        errorMessage = "Invalid or missing Google Generative AI API key";
      } else if (error.message.includes("QUOTA_EXCEEDED") || error.message.includes("RESOURCE_EXHAUSTED")) {
        errorMessage = "API quota exceeded. Please try again later or upgrade your plan";
      } else if (error.message.includes("PERMISSION_DENIED")) {
        errorMessage = "Permission denied. Check your API key permissions";
      } else if (error.message.includes("NOT_FOUND")) {
        errorMessage = "Video not found or is private/unavailable";
      } else if (error.message.includes("INVALID_ARGUMENT")) {
        errorMessage = "Invalid video format or unsupported content";
      } else {
        errorMessage = error.message;
      }
    }

    // Update job with error
    await db.update(schema.videoAnalysisJobs)
      .set({
        status: "failed",
        error: errorMessage,
        processing_time: processingTime,
        completed_at: new Date()
      })
      .where(eq(schema.videoAnalysisJobs.id, jobId));
  }
}

// Queue consumer
export default {
  ...app,
  async queue(batch: MessageBatch<QueueMessage>, env: Bindings): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processVideoAnalysis(message.body.jobId, env);
        message.ack();
      } catch (error) {
        console.error('Queue processing error:', error);
        message.retry();
      }
    }
  }
};

// Create MCP server
function createMcpServer(env: Bindings) {
  const server = new McpServer({
    name: "youtube-video-analyzer",
    version: "2.0.0",
    description: "Asynchronous YouTube video analysis with AI-powered insights"
  });

  const db = drizzle(env.DB);

  // Analyze YouTube video tool
  server.tool(
    "analyze_youtube_video",
    {
      video_url: z.string().url().describe("YouTube video URL to analyze"),
      question: z.string().describe("Question or analysis focus for the video"),
      model: z.string().default("gemini-2.5-flash").describe("AI model to use for analysis"),
      force_low_resolution: z.boolean().default(false).describe("Force low resolution processing")
    },
    async ({ video_url, question, model, force_low_resolution }) => {
      try {
        // Extract video ID
        const videoId = extractVideoId(video_url);
        if (!videoId) {
          return {
            content: [{
              type: "text",
              text: "Invalid YouTube URL format"
            }],
            isError: true
          };
        }

        // Get video details from YouTube API
        const videoDetails = await getYouTubeVideoDetails(videoId, env.YOUTUBE_API_KEY);
        if (!videoDetails) {
          return {
            content: [{
              type: "text",
              text: "Could not fetch video details. Video may be private or unavailable."
            }],
            isError: true
          };
        }

        // Calculate duration and determine resolution
        const durationSeconds = parseDuration(videoDetails.contentDetails.duration);
        const useLowResolution = force_low_resolution || durationSeconds > 3600; // 1 hour

        // Create job
        const [newJob] = await db.insert(schema.videoAnalysisJobs)
          .values({
            youtube_url: video_url,
            question,
            model,
            use_low_resolution: useLowResolution,
            estimated_duration: durationSeconds
          })
          .returning();

        // Send job to queue for processing
        await env.VIDEO_ANALYSIS_QUEUE.send({ jobId: newJob.id });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              job_id: newJob.id,
              status: newJob.status,
              video_title: videoDetails.snippet.title,
              channel: videoDetails.snippet.channelTitle,
              duration_seconds: durationSeconds,
              using_low_resolution: useLowResolution,
              message: "Video analysis job created and queued for processing"
            }, null, 2)
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error creating analysis job: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Check job status tool
  server.tool(
    "check_video_analysis_status",
    {
      job_id: z.string().describe("Job ID to check status for")
    },
    async ({ job_id }) => {
      try {
        const [job] = await db.select()
          .from(schema.videoAnalysisJobs)
          .where(eq(schema.videoAnalysisJobs.id, job_id));

        if (!job) {
          return {
            content: [{
              type: "text",
              text: "Job not found"
            }],
            isError: true
          };
        }

        const response = {
          job_id: job.id,
          status: job.status,
          youtube_url: job.youtube_url,
          question: job.question,
          model: job.model,
          created_at: job.created_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          processing_time: job.processing_time,
          estimated_duration: job.estimated_duration,
          use_low_resolution: job.use_low_resolution,
          result: job.result,
          error: job.error
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2)
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error checking job status: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // List jobs tool
  server.tool(
    "list_video_analysis_jobs",
    {
      status: z.enum(["pending", "processing", "completed", "failed"]).optional().describe("Filter by job status"),
      limit: z.number().min(1).max(100).default(20).describe("Maximum number of jobs to return")
    },
    async ({ status, limit }) => {
      try {
        let query = db.select().from(schema.videoAnalysisJobs);
        
        if (status) {
          query = query.where(eq(schema.videoAnalysisJobs.status, status)) as any;
        }
        
        const jobs = await query
          .orderBy(desc(schema.videoAnalysisJobs.created_at))
          .limit(limit) as any;

        const jobSummaries = jobs.map((job: any) => ({
          job_id: job.id,
          status: job.status,
          youtube_url: job.youtube_url,
          question: job.question.substring(0, 100) + (job.question.length > 100 ? '...' : ''),
          model: job.model,
          created_at: job.created_at,
          completed_at: job.completed_at,
          processing_time: job.processing_time,
          has_result: !!job.result,
          has_error: !!job.error
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total_jobs: jobSummaries.length,
              jobs: jobSummaries
            }, null, 2)
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error listing jobs: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  return server;
}

// API Routes
app.get("/", (c) => {
  return c.text("YouTube Video Analysis MCP Server");
});

// Create new analysis job
app.post("/api/jobs", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const { video_url, question, model = "gemini-2.5-flash", force_low_resolution = false } = await c.req.json();
    
    if (!video_url || !question) {
      return c.json({ error: "video_url and question are required" }, 400);
    }

    const videoId = extractVideoId(video_url);
    if (!videoId) {
      return c.json({ error: "Invalid YouTube URL format" }, 400);
    }

    const videoDetails = await getYouTubeVideoDetails(videoId, c.env.YOUTUBE_API_KEY);
    if (!videoDetails) {
      return c.json({ error: "Could not fetch video details" }, 400);
    }

    const durationSeconds = parseDuration(videoDetails.contentDetails.duration);
    const useLowResolution = force_low_resolution || durationSeconds > 3600;

    const [newJob] = await db.insert(schema.videoAnalysisJobs)
      .values({
        youtube_url: video_url,
        question,
        model,
        use_low_resolution: useLowResolution,
        estimated_duration: durationSeconds
      })
      .returning();

    // Queue job for processing
    await c.env.VIDEO_ANALYSIS_QUEUE.send({ jobId: newJob.id });

    return c.json({
      job_id: newJob.id,
      status: newJob.status,
      video_title: videoDetails.snippet.title,
      channel: videoDetails.snippet.channelTitle,
      duration_seconds: durationSeconds,
      using_low_resolution: useLowResolution
    }, 201);

  } catch (error) {
    return c.json({ 
      error: "Failed to create job",
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get job status and results
app.get("/api/jobs/:jobId", async (c) => {
  const db = drizzle(c.env.DB);
  const jobId = c.req.param("jobId");

  try {
    const [job] = await db.select()
      .from(schema.videoAnalysisJobs)
      .where(eq(schema.videoAnalysisJobs.id, jobId));

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    return c.json(job);

  } catch (error) {
    return c.json({ 
      error: "Failed to fetch job",
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// List all jobs
app.get("/api/jobs", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const status = c.req.query("status") as "pending" | "processing" | "completed" | "failed" | undefined;
    const limit = Number.parseInt(c.req.query("limit") || "20");
    const offset = Number.parseInt(c.req.query("offset") || "0");

    let query = db.select().from(schema.videoAnalysisJobs);
    
    if (status) {
      query = query.where(eq(schema.videoAnalysisJobs.status, status)) as any;
    }
    
    const jobs = await query
      .orderBy(desc(schema.videoAnalysisJobs.created_at))
      .limit(limit)
      .offset(offset) as any;

    return c.json({ jobs });

  } catch (error) {
    return c.json({ 
      error: "Failed to fetch jobs",
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// MCP endpoint
app.all("/mcp", async (c) => {
  const mcpServer = createMcpServer(c.env);
  const transport = new StreamableHTTPTransport();
  
  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

// OpenAPI spec
app.get("/openapi.json", c => {
  return c.json(createOpenAPISpec(app, {
    info: {
      title: "YouTube Video Analysis MCP Server",
      version: "2.0.0",
      description: "Asynchronous YouTube video analysis with AI-powered insights"
    },
  }));
});

// Fiberplane explorer
app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" }
}));