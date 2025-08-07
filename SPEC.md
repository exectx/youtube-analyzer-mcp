# YouTube Video Analysis MCP Server Specification

This document outlines the design and implementation plan for a YouTube Video Analysis MCP server that provides intelligent video content analysis capabilities.

The MCP server will support video transcript extraction, content summarization, key moment identification, and intelligent Q&A about video content using Google's Gemini AI models through the latest @google/genai SDK.

The system will be built using Cloudflare Workers with Hono as the API framework, Google Gemini AI for video analysis, and Cloudflare D1 for caching analysis results.

## 1. Technology Stack

- **Edge Runtime:** Cloudflare Workers
- **API Framework:** Hono.js (TypeScript-based API framework)
- **MCP Framework:** @modelcontextprotocol/sdk with @hono/mcp
- **AI Provider:** @google/genai SDK (latest version)
- **Database:** Cloudflare D1 (SQLite)
- **ORM:** Drizzle ORM
- **Queue Processing:** Cloudflare Queues (for long video processing)
- **Storage:** Cloudflare R2 (for caching video thumbnails and processed data)

## 2. Database Schema Design

The database will store video analysis results, user sessions, and processing status for efficient caching and retrieval.

### 2.1. videos Table

- id (TEXT, Primary Key) - YouTube video ID
- title (TEXT, NOT NULL)
- duration (INTEGER) - Video duration in seconds
- channel_name (TEXT)
- upload_date (TEXT)
- thumbnail_url (TEXT)
- created_at (TEXT, DEFAULT CURRENT_TIMESTAMP)
- updated_at (TEXT, DEFAULT CURRENT_TIMESTAMP)

### 2.2. video_analyses Table

- id (INTEGER, Primary Key, Auto Increment)
- video_id (TEXT, Foreign Key to videos.id)
- analysis_type (TEXT, NOT NULL) - 'summary', 'transcript', 'key_moments', 'qa'
- content (TEXT, NOT NULL) - JSON string containing analysis results
- model_used (TEXT) - Gemini model version used
- processing_status (TEXT, DEFAULT 'completed') - 'pending', 'processing', 'completed', 'failed'
- created_at (TEXT, DEFAULT CURRENT_TIMESTAMP)

### 2.3. processing_queue Table

- id (INTEGER, Primary Key, Auto Increment)
- video_id (TEXT, NOT NULL)
- analysis_type (TEXT, NOT NULL)
- priority (INTEGER, DEFAULT 0)
- status (TEXT, DEFAULT 'queued') - 'queued', 'processing', 'completed', 'failed'
- error_message (TEXT)
- created_at (TEXT, DEFAULT CURRENT_TIMESTAMP)
- started_at (TEXT)
- completed_at (TEXT)

## 3. MCP Server Tools

The MCP server will expose several tools for YouTube video analysis capabilities.

### 3.1. analyze_youtube_video Tool

- **Description:** Analyzes a YouTube video and provides comprehensive insights
- **Parameters:**
  ```json
  {
    "video_url": "string (required) - YouTube video URL or ID",
    "analysis_types": "array (optional) - ['summary', 'transcript', 'key_moments', 'qa'] - defaults to ['summary']",
    "questions": "array (optional) - Specific questions to ask about the video content"
  }
  ```

### 3.2. get_video_transcript Tool

- **Description:** Extracts and returns the full transcript of a YouTube video
- **Parameters:**
  ```json
  {
    "video_url": "string (required) - YouTube video URL or ID",
    "include_timestamps": "boolean (optional) - Include timestamp markers, defaults to true"
  }
  ```

### 3.3. summarize_video Tool

- **Description:** Generates an intelligent summary of video content
- **Parameters:**
  ```json
  {
    "video_url": "string (required) - YouTube video URL or ID",
    "summary_length": "string (optional) - 'brief', 'detailed', 'comprehensive' - defaults to 'detailed'",
    "focus_areas": "array (optional) - Specific topics to focus on in summary"
  }
  ```

### 3.4. find_key_moments Tool

- **Description:** Identifies and extracts key moments and highlights from the video
- **Parameters:**
  ```json
  {
    "video_url": "string (required) - YouTube video URL or ID",
    "moment_types": "array (optional) - ['highlights', 'topics', 'quotes', 'transitions'] - defaults to ['highlights']"
  }
  ```

### 3.5. ask_about_video Tool

- **Description:** Answers specific questions about video content using AI analysis
- **Parameters:**
  ```json
  {
    "video_url": "string (required) - YouTube video URL or ID",
    "question": "string (required) - Question about the video content"
  }
  ```

## 4. API Endpoints

Supporting REST API endpoints for direct access and media serving.

### 4.1. Video Analysis Endpoints

- **POST /api/analyze**
  - Description: Trigger video analysis with specified parameters
  - Expected Payload:
    ```json
    {
      "video_url": "https://youtube.com/watch?v=...",
      "analysis_types": ["summary", "transcript"],
      "options": {
        "summary_length": "detailed",
        "include_timestamps": true
      }
    }
    ```

- **GET /api/analysis/:video_id**
  - Description: Retrieve cached analysis results for a video
  - Query Params: analysis_type, format

- **GET /api/status/:job_id**
  - Description: Check processing status for long-running analysis jobs
  - Returns: Processing status, progress, estimated completion time

### 4.2. Media Serving Endpoints

- **GET /api/thumbnail/:video_id**
  - Description: Serve cached video thumbnails from R2 storage
  - Query Params: size (small, medium, large)

- **GET /api/export/:video_id**
  - Description: Export analysis results in various formats (JSON, PDF, markdown)
  - Query Params: format, analysis_types

## 5. Integrations

### 5.1. Google Gemini AI Integration

- **@google/genai SDK** for video understanding and analysis
- Support for Gemini 2.5 Flash and Pro models for different complexity levels
- Video understanding capabilities with low resolution support for long videos
- Proper error handling and rate limiting

### 5.2. YouTube Data API Integration

- Extract video metadata, thumbnails, and basic information
- Handle various YouTube URL formats and video ID extraction
- Respect YouTube's terms of service and rate limits

### 5.3. Cloudflare Services Integration

- **Cloudflare Queues** for processing long videos asynchronously
- **Cloudflare R2** for caching processed results and thumbnails
- **Cloudflare D1** for persistent storage of analysis results
- **Cloudflare Workers Analytics** for monitoring and performance tracking

## 6. Additional Notes

### 6.1. Environment Variables and Bindings

The following environment variables and bindings should be configured:

```typescript
type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  ANALYSIS_QUEUE: Queue;
  GOOGLE_AI_API_KEY: string;
  YOUTUBE_API_KEY: string;
};
```

### 6.2. Processing Strategy

- **Short videos (< 10 minutes):** Process immediately with high-resolution analysis
- **Long videos (> 10 minutes):** Queue for background processing with low-resolution analysis
- **Very long videos (> 1 hour):** Chunk processing with progress tracking

### 6.3. Caching Strategy

- Cache analysis results in D1 for 7 days
- Store thumbnails and processed media in R2 with 30-day expiration
- Implement cache invalidation for updated video content

### 6.4. Error Handling

- Graceful handling of private/unavailable videos
- Retry logic for transient API failures
- Comprehensive error messages for debugging

## 7. Migration and Documentation References

- **Google AI SDK Migration:** Follow the official migration guide from @google/generative-ai to @google/genai
- **Video Understanding:** Leverage Google's video understanding documentation for optimal model usage
- **Cloudflare Workers:** Use latest Cloudflare Workers patterns for queue processing and R2 integration

## 8. Further Reading

Take inspiration from the project template here: https://github.com/fiberplane/create-honc-app/tree/main/templates/d1

Reference Google's video understanding capabilities: https://ai.google.dev/gemini-api/docs/video-understanding