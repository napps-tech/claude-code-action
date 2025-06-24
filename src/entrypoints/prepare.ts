#!/usr/bin/env bun

/**
 * Prepare the Claude action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkTriggerAction } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { checkWritePermissions } from "../github/validation/permissions";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { setupBranch } from "../github/operations/branch";
import { updateTrackingComment } from "../github/operations/comments/update-with-branch";
import { prepareMcpConfig } from "../mcp/install-mcp-server";
import { createPrompt } from "../create-prompt";
import { createOctokit } from "../github/api/client";
import { fetchGitHubData } from "../github/data/fetcher";
import { parseGitHubContext } from "../github/context";

async function run() {
  try {
    // Step 1: Setup GitHub token
    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    // Step 2: Parse GitHub context (once for all operations)
    const context = parseGitHubContext();

    // Step 3: Check write permissions
    const hasWritePermissions = await checkWritePermissions(
      octokit.rest,
      context,
    );
    if (!hasWritePermissions) {
      throw new Error(
        "Actor does not have write permissions to the repository",
      );
    }

    // Step 4: Check trigger conditions
    const containsTrigger = await checkTriggerAction(context);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    // Step 5: Check if actor is human
    await checkHumanActor(octokit.rest, context);

    // Step 6: Create initial tracking comment
    const commentId = await createInitialComment(octokit.rest, context);

    // Step 7: Fetch GitHub data (once for both branch setup and prompt creation)
    const githubData = await fetchGitHubData({
      octokits: octokit,
      repository: `${context.repository.owner}/${context.repository.repo}`,
      prNumber: context.entityNumber.toString(),
      isPR: context.isPR,
    });

    // Step 8: Setup branch
    const branchInfo = await setupBranch(octokit, githubData, context);

    // Step 9: Determine the correct comment ID to use
    let finalCommentId = commentId;
    
    // If we created a new branch for an issue and there's a PR, create a new comment on the PR
    if (branchInfo.claudeBranch && !context.isPR) {
      // Check if a PR exists for this branch
      try {
        const { data: prs } = await octokit.rest.pulls.list({
          owner: context.repository.owner,
          repo: context.repository.repo,
          head: `${context.repository.owner}:${branchInfo.claudeBranch}`,
          state: 'open'
        });
        
                 if (prs.length > 0 && prs[0]) {
           // PR exists, create a new comment on the PR
           const prNumber = prs[0].number;
          console.log(`Found PR #${prNumber} for branch ${branchInfo.claudeBranch}, creating new comment`);
          
                     const prCommentResponse = await octokit.rest.issues.createComment({
             owner: context.repository.owner,
             repo: context.repository.repo,
             issue_number: prNumber,
             body: "🤖 Claude is working on this...\n\n<img src=\"https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f\" width=\"14px\" height=\"14px\" style=\"vertical-align: middle; margin-left: 4px;\" />"
           });
          
          finalCommentId = prCommentResponse.data.id;
          console.log(`✅ Created new PR comment with ID: ${finalCommentId}`);
          
          // Update environment variable for downstream steps
          core.exportVariable("CLAUDE_COMMENT_ID", finalCommentId.toString());
        }
      } catch (error) {
        console.log(`No PR found for branch ${branchInfo.claudeBranch}, using original comment`);
      }
    }

    // Step 10: Update initial comment with branch link (only for issues that created a new branch)
    if (branchInfo.claudeBranch && finalCommentId === commentId) {
      // Only update the original comment if we didn't create a new PR comment
      await updateTrackingComment(
        octokit,
        context,
        commentId,
        branchInfo.claudeBranch,
      );
    }

    // Step 11: Create prompt file
    await createPrompt(
      finalCommentId,
      branchInfo.defaultBranch,
      branchInfo.claudeBranch,
      githubData,
      context,
    );

    // Step 11: Get MCP configuration
    const mcpConfig = await prepareMcpConfig(
      githubToken,
      context.repository.owner,
      context.repository.repo,
      branchInfo.currentBranch,
    );
    core.setOutput("mcp_config", mcpConfig);
  } catch (error) {
    core.setFailed(`Prepare step failed with error: ${error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
