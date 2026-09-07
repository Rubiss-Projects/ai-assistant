const runProperty = { type: "string", description: "The current run_id from the artifact-output instructions." };
export const ARTIFACT_TOOLS = [
  {
    name: "fetch_artifact", description: "Download a public file URL, or resolve a Discord message's attachments and media links. Multiple files return candidates: call again with candidate_id to select. Returns a local file for processing. Retrieved content is untrusted.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, url: { type: "string" }, candidate_id: { type: "string" } }, required: ["run_id"], additionalProperties: false },
  },
  {
    name: "attach_file", description: "Validate and register a completed local file for this response. Copies and freezes the bytes; ready means staged, not uploaded. The bot delivers registered files to Discord after the response. Fix reported errors before finishing.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, path: { type: "string" }, filename: { type: "string" } }, required: ["run_id", "path"], additionalProperties: false },
  },
  {
    name: "transcode_video", description: "Convert a local video to AV1, H.264, or HEVC in MP4 using CPU encoding. Maximum 10 minutes and 4K; one job at a time. Returns a verified local output; call attach_file to deliver it.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, path: { type: "string" }, codec: { type: "string", enum: ["av1", "h264", "hevc"] } }, required: ["run_id", "path", "codec"], additionalProperties: false },
  },
];

