// Immutable literal fixture; independent canonical SHA256 calculation.
import type { Session, SemanticSeedV1 } from '../../src/index.ts'

export const literalSeed: SemanticSeedV1 = {
  "version": 1,
  "selection": {
    "kind": "all"
  },
  "turns": {
    "total": 2,
    "completed": [
      [
        1,
        2
      ]
    ],
    "unframedPrefix": false
  },
  "groups": [
    {
      "extent": {
        "kind": "framed",
        "first": 1,
        "last": 2
      },
      "items": [
        {
          "scope": "turn",
          "extent": {
            "kind": "framed",
            "first": 1,
            "last": 2
          },
          "origins": [
            {
              "origin": 0,
              "seq": 4,
              "part": "message"
            }
          ],
          "sourceProvenance": [
            {
              "origin": 0,
              "kind": "summary",
              "authority": "derived",
              "scope": "turn"
            }
          ],
          "kind": "summary",
          "messages": [
            {
              "role": "user",
              "content": "inherited preface"
            }
          ]
        },
        {
          "scope": "turn",
          "extent": {
            "kind": "framed",
            "first": 1,
            "last": 2
          },
          "origins": [
            {
              "origin": 0,
              "seq": 4,
              "part": "message"
            }
          ],
          "sourceProvenance": [
            {
              "origin": 0,
              "kind": "model",
              "authority": "observation",
              "scope": "turn"
            }
          ],
          "kind": "exchange",
          "messages": [
            {
              "role": "assistant",
              "content": "",
              "toolCalls": [
                {
                  "id": "same",
                  "name": "read",
                  "args": {}
                }
              ]
            },
            {
              "role": "tool",
              "toolCallId": "same",
              "content": "seed exact"
            }
          ],
          "sourceAcceptance": "legacy-inferred",
          "calls": [
            {
              "id": "same",
              "name": "read",
              "assistantMessage": 0,
              "call": 0,
              "result": 0,
              "outcome": "success",
              "source": [
                {
                  "origin": 0,
                  "seq": 4,
                  "part": "call"
                }
              ]
            }
          ],
          "results": [
            {
              "kind": "legacy",
              "message": 1,
              "source": [
                {
                  "origin": 0,
                  "seq": 5,
                  "part": "result"
                }
              ],
              "media": []
            }
          ]
        }
      ]
    }
  ],
  "artifacts": [],
  "omissions": [],
  "origins": [
    {
      "kind": "session",
      "sessionId": "parent",
      "revision": "292a04098eb3eb9bd87d223c8f1497650583a1fb47e0b1bf49e62f7d730cb759"
    }
  ]
}

export const literalReady: Session = {
  "formatVersion": 11,
  "header": {
    "seedLength": 2,
    "semanticSeed": {
      "version": 1,
      "codec": "semantic-seed-v1",
      "operationId": "literal",
      "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "manifestDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "seedDigest": "9d5c8883be3c13c41720b5eb99708e626515685554288c65cd6b8150ac363372",
      "dependencyDigest": "7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c",
      "seedLength": 2,
      "groupCount": 1
    }
  },
  "events": [
    {
      "selection": {
        "kind": "all"
      },
      "turns": {
        "total": 2,
        "completed": [
          [
            1,
            2
          ]
        ],
        "unframedPrefix": false
      },
      "artifacts": [],
      "omissions": [],
      "origins": [
        {
          "kind": "session",
          "sessionId": "parent",
          "revision": "292a04098eb3eb9bd87d223c8f1497650583a1fb47e0b1bf49e62f7d730cb759"
        }
      ],
      "type": "conversation/seed-manifest",
      "version": 1,
      "seq": 0,
      "codec": "semantic-seed-v1",
      "digest": "9d5c8883be3c13c41720b5eb99708e626515685554288c65cd6b8150ac363372",
      "groupCount": 1
    },
    {
      "type": "conversation/seed-group",
      "version": 1,
      "seq": 1,
      "manifestSeq": 0,
      "ordinal": 0,
      "group": {
        "extent": {
          "kind": "framed",
          "first": 1,
          "last": 2
        },
        "items": [
          {
            "scope": "turn",
            "extent": {
              "kind": "framed",
              "first": 1,
              "last": 2
            },
            "origins": [
              {
                "origin": 0,
                "seq": 4,
                "part": "message"
              }
            ],
            "sourceProvenance": [
              {
                "origin": 0,
                "kind": "summary",
                "authority": "derived",
                "scope": "turn"
              }
            ],
            "kind": "summary",
            "messages": [
              {
                "role": "user",
                "content": "inherited preface"
              }
            ]
          },
          {
            "scope": "turn",
            "extent": {
              "kind": "framed",
              "first": 1,
              "last": 2
            },
            "origins": [
              {
                "origin": 0,
                "seq": 4,
                "part": "message"
              }
            ],
            "sourceProvenance": [
              {
                "origin": 0,
                "kind": "model",
                "authority": "observation",
                "scope": "turn"
              }
            ],
            "kind": "exchange",
            "messages": [
              {
                "role": "assistant",
                "content": "",
                "toolCalls": [
                  {
                    "id": "same",
                    "name": "read",
                    "args": {}
                  }
                ]
              },
              {
                "role": "tool",
                "toolCallId": "same",
                "content": "seed exact"
              }
            ],
            "sourceAcceptance": "legacy-inferred",
            "calls": [
              {
                "id": "same",
                "name": "read",
                "assistantMessage": 0,
                "call": 0,
                "result": 0,
                "outcome": "success",
                "source": [
                  {
                    "origin": 0,
                    "seq": 4,
                    "part": "call"
                  }
                ]
              }
            ],
            "results": [
              {
                "kind": "legacy",
                "message": 1,
                "source": [
                  {
                    "origin": 0,
                    "seq": 5,
                    "part": "result"
                  }
                ],
                "media": []
              }
            ]
          }
        ]
      }
    },
    {
      "type": "session/bootstrap",
      "version": 1,
      "seq": 2,
      "operationId": "literal",
      "manifestDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "dependencyClosureDigest": "7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c",
      "seedLength": 2
    }
  ]
}
