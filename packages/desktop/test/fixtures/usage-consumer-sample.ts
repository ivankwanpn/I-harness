import type {UsageSnapshotV2} from '@i-harness/usage-stats/observation-snapshot'
// Exact Unit A actual handler vector; no producer/child runtime claim.
export const usageConsumerSample:UsageSnapshotV2 = {
  "kind": "usage-observation-snapshot",
  "version": 2,
  "query": {
    "start": 0,
    "end": 20,
    "timeZone": "UTC",
    "page": 1,
    "pageSize": 50,
    "sort": "newest"
  },
  "coverage": {
    "recordingMode": "legacy",
    "observationStorage": "present",
    "status": "partial",
    "warnings": [
      "Observation recording is not enabled; only previously recorded observations are shown.",
      "Usage is a point-in-time read; missing observations and active writes may make coverage incomplete."
    ]
  },
  "summary": {
    "logicalActions": 1,
    "transportHandoffs": 1,
    "localInvocations": 0,
    "unknownReservations": 0,
    "knownUnsentCandidates": 0,
    "unknownUsage": 0,
    "unattributedInvocations": 0,
    "legacyInvocations": 1,
    "measuredSends": 1,
    "unavailableSends": 0,
    "measuredInputSubtotal": 8,
    "measuredOutputSubtotal": 3,
    "measuredTokenSubtotal": 11,
    "cacheHitRate": null
  },
  "daily": [
    {
      "date": "1970-01-01",
      "summary": {
        "logicalActions": 1,
        "transportHandoffs": 1,
        "localInvocations": 0,
        "unknownReservations": 0,
        "knownUnsentCandidates": 0,
        "unknownUsage": 0,
        "unattributedInvocations": 0,
        "legacyInvocations": 0,
        "measuredSends": 1,
        "unavailableSends": 0,
        "measuredInputSubtotal": 8,
        "measuredOutputSubtotal": 3,
        "measuredTokenSubtotal": 11,
        "cacheHitRate": null
      }
    }
  ],
  "models": [
    {
      "key": "[\"child-provider\",\"child-model\"]",
      "label": "child-model",
      "transportHandoffs": 1,
      "measuredSends": 1,
      "unavailableSends": 0,
      "measuredTokenSubtotal": 11
    }
  ],
  "providers": [
    {
      "key": "[\"child-provider\",\"child-provider\"]",
      "label": "child-provider",
      "transportHandoffs": 1,
      "measuredSends": 1,
      "unavailableSends": 0,
      "measuredTokenSubtotal": 11
    }
  ],
  "rows": [
    {
      "kind": "send",
      "key": "[\"send\",\"s\",\"a\",\"t\",\"send\"]",
      "at": 10,
      "value": {
        "ownerSessionId": "s",
        "actionId": "a",
        "attemptId": "t",
        "sendId": "send",
        "handoffAt": 10,
        "lane": "main",
        "rebind": 0,
        "durable": true,
        "disposition": null,
        "totalInputTokens": 8,
        "uncachedInputTokens": null,
        "totalTokens": 11,
        "coverage": "complete",
        "estimatedCostUsd": null,
        "costCoverage": "unavailable",
        "billing": "api",
        "modelId": "child-model",
        "providerId": "child-provider",
        "workspace": "w",
        "inputTokens": 8,
        "outputTokens": 3,
        "inputTokenSemantics": "includes-cache"
      }
    },
    {
      "kind": "action",
      "key": "[\"action\",\"s\",\"a\"]",
      "at": 1,
      "value": {
        "ownerSessionId": "s",
        "actionId": "a",
        "startedAt": 1,
        "purpose": "main",
        "origin": {
          "kind": "input",
          "seq": 0
        },
        "executionDomain": "physical",
        "disposition": null,
        "durable": true
      }
    }
  ],
  "totalRows": 2,
  "page": 1,
  "pageSize": 50,
  "legacy": {
    "generatedAt": 1793525338294,
    "summary": {
      "requests": 1,
      "completed": 0,
      "failed": 1,
      "cancelled": 0,
      "inputTokens": null,
      "uncachedInputTokens": null,
      "outputTokens": null,
      "cacheReadTokens": null,
      "cacheCreationTokens": null,
      "totalTokens": null,
      "chartTokens": null,
      "cacheHitRate": null,
      "measuredRequests": 0,
      "cacheMeasuredRequests": 0,
      "estimatedCostUsd": null,
      "pricedRequests": 0,
      "subscriptionRequests": 1
    },
    "daily": [
      {
        "date": "1970-01-01",
        "requests": 1,
        "completed": 0,
        "failed": 1,
        "cancelled": 0,
        "inputTokens": null,
        "uncachedInputTokens": null,
        "outputTokens": null,
        "cacheReadTokens": null,
        "cacheCreationTokens": null,
        "totalTokens": null,
        "chartTokens": null,
        "cacheHitRate": null,
        "measuredRequests": 0,
        "cacheMeasuredRequests": 0,
        "estimatedCostUsd": null,
        "pricedRequests": 0,
        "subscriptionRequests": 1
      }
    ],
    "models": [
      {
        "key": "old",
        "label": "old",
        "requests": 1,
        "completed": 0,
        "failed": 1,
        "cancelled": 0,
        "inputTokens": null,
        "uncachedInputTokens": null,
        "outputTokens": null,
        "cacheReadTokens": null,
        "cacheCreationTokens": null,
        "totalTokens": null,
        "chartTokens": null,
        "cacheHitRate": null,
        "measuredRequests": 0,
        "cacheMeasuredRequests": 0,
        "estimatedCostUsd": null,
        "pricedRequests": 0,
        "subscriptionRequests": 1
      }
    ],
    "providers": [
      {
        "key": "legacy",
        "label": "legacy",
        "requests": 1,
        "completed": 0,
        "failed": 1,
        "cancelled": 0,
        "inputTokens": null,
        "uncachedInputTokens": null,
        "outputTokens": null,
        "cacheReadTokens": null,
        "cacheCreationTokens": null,
        "totalTokens": null,
        "chartTokens": null,
        "cacheHitRate": null,
        "measuredRequests": 0,
        "cacheMeasuredRequests": 0,
        "estimatedCostUsd": null,
        "pricedRequests": 0,
        "subscriptionRequests": 1
      }
    ],
    "records": [
      {
        "id": "old",
        "startedAt": 5,
        "durationMs": 1,
        "workspace": "w",
        "providerId": "legacy",
        "modelId": "old",
        "billing": "subscription",
        "status": "failed",
        "totalInputTokens": null,
        "uncachedInputTokens": null,
        "totalTokens": null,
        "estimatedCostUsd": null
      }
    ],
    "totalRecords": 1,
    "page": 1,
    "pageSize": 50,
    "options": {
      "workspaces": [
        "w"
      ],
      "projects": [],
      "providers": [
        "legacy"
      ],
      "models": [
        "old"
      ]
    },
    "prices": [
      {
        "providerId": "child-provider",
        "modelId": "child-model",
        "inputPerMillion": 1,
        "outputPerMillion": 2,
        "source": "user",
        "updatedAt": 1
      }
    ],
    "warnings": [],
    "recordingSince": 5
  },
  "prices": [
    {
      "providerId": "child-provider",
      "modelId": "child-model",
      "inputPerMillion": 1,
      "outputPerMillion": 2,
      "source": "user",
      "updatedAt": 1
    }
  ],
  "options": {
    "workspaces": [
      "w"
    ],
    "projects": [],
    "providers": [
      "child-provider",
      "legacy"
    ],
    "models": [
      "child-model",
      "old"
    ]
  }
}
