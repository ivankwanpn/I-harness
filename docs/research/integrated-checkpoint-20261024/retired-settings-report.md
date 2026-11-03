# Root leaf repair: retired single-store preferences

BASEa41230d96a84ba2ca14fa2cc36fc30ab3adc85f9. Only product single-store.ts and retired-tui-keys.test.ts changed; root MAIN writer/runtime. Scoped implementation, pending fresh independent review. No W2 layered/watch code touched; no live profile.

Cause: accepted raw preservation merges this.raw with normalizedsettings, restoring three known retired top-level keys that projection intentionally omits. Existing first-writecontract failed. Existing ordinary save now removes only theme/busyEnter/transcriptMode, retaining unknownrootextensiondata and existingprovider/instruction semantics. No rewriteonload; digest-boundexplicitimport untouched. No broad unknown-key deletion/migrationchain.

Evidence in this SDD: retired-settings-red.log reproduces original1fail/3pass; retired-settings-expanded-red.log adds set/reset unknown-extension/provenance/reopen controls and gives3fail/3pass, each failing on exactretiredkeys. Minimal3line product change afterRED. Final retired-settings-green.log actual4files110pass/exit0 (retired,settings,sections,instructions); retired-settings-types.log exit0. Bothcommands package-CWD and sequential, worker2/1. Finalbefore/after2fileSHA256 identical. Parentproperty of nested extension contains its own theme and survives. Existing6tests cover readnorewrite, oldactiveTUI/providerdata, explicitnativeinstructionprovenance andresetdefaultbehavior. Doesnotclaimallsettings orpackagedgate.

Root manualdiffcheck passes. Review code/brief and exactcommitrange before claimingclosedreleaseobligation. Productversion/format unchanged; no remoteoperation. WholecombinedsettingsafterW2integration stillrequired because previousbranchheld thisknownfailure.
