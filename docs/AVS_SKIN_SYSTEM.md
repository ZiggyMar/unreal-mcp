# The AntiVirusSquad skin system, as it actually is

Written because this tool spent an afternoon fixing the wrong one. Every claim here was read out of
the project with `unreal_trace_function_calls`, `unreal_trace_variable` and `unreal_read_node_detail`,
and the reachability verdicts are the tool's, not a guess.

## There are two systems. One is dead.

**Dead — do not fix.** `ServerSkinMemory` (a `Map<netId,int>` on `AVS_GameInstance`), `SkinDeck` /
`ChosenSkin` / `GetNextTicket` / `BurnTicket` on `GS_Gameplay`, `AssignedSkinID` on `PS_Gameplay`,
and `SelectedMeshIndex` / `OnRep_SelectedMeshIndex` / `ApplySelectedMesh` on `BP_Player`.

The evidence it is dead, rather than broken:

- `ServerSkinMemory` is **read** by `GM_Gameplay` and `GM_TutGameplay` and **written by nobody**.
- `SelectedMeshIndex` is **written by nobody**, so its RepNotify never fires, so `ApplySelectedMesh`
  never runs — `trace_function_calls` reports exactly that.
- `AttemptSkinUpdate` is **called by nobody**.
- `BurnTicket` takes no parameter, always reads `SkinDeck[0]`, and then removes at index = that
  *value*. It conflates value and index. It has never worked, and nothing reaches it.

It was replaced because it handled mid-round joins, rejoins and respawns badly.

## Live path

```text
LOBBY
  GM_Lobby.BeginPlay          -> SetupSkins            fills AvailableSkins from DT_SkinData rows
  GM_Lobby.Skin Selection     -> GetRandomValidSkin    picks a free one (uniqueness lives here)
                              -> Set CurrentSkin
                              -> CE_SkinSelection      Client RPC, runs on the OWNING CLIENT
  PC_Lobby.SkinSeleciton      -> Set SelectedSkin       on that client's own AVS_GameInstance
                                                        (a GameInstance survives level travel)

MATCH
  BP_Player.InitialSetup      -> SetHealth -> SetEnergy
                              -> GetSkinFromGI          Client RPC, runs on the OWNING CLIENT
  (client)                    -> reads its GI SelectedSkin
                              -> UpdatePlayerSkin       Server RPC, reliable
  (server)                    -> Get Data Table Row DT_SkinData
                              -> Set with Notify SkinData
  (everyone)                  -> OnRep_SkinData -> Set Skeletal Mesh Asset
```

Skin ids are `DT_SkinData` **row names**: `Bunny`, `Devil`, `Squiddy`, `Starry`.

Two loops in `BP_Player.EventGraph` also walk `DT_SkinData`, and neither assigns a skin — both are
readers, deriving `SkinName`, `Player Color` and `Player Ping Icon Texture` from the chosen row.
`CE_GetPlayer'sSkin` and `CE_AttemptSetName` are where they live.

## Why you spawn as the bunny and it changes ~2s later

No bug is involved. The mesh cannot change until **server → owning client → server → replicate back**
completes, and until then the pawn wears its Blueprint default. That default is Bunny, which is row 0
of `DT_SkinData`. Shortening it means moving the client's answer earlier (it currently waits for the
pawn's `InitialSetup`) or hiding the mesh until `SkinData` arrives — not fixing a fault.

## Checked and NOT the cause

- **`CE_SkinSelection` running on the server instead of the client.** It looked like the classic
  "works for the host" bug: a GameMode is server-only, so a plain event called on a PlayerController
  from it would set the *server's* GameInstance. It is not plain — it is `RELIABLE Replicated From
  Server, Executes on Owning Client`. Correct as written. This hypothesis was tested before anything
  was changed, and it was wrong.

## Still open

Uniqueness is enforced **in the lobby only** (`GetRandomValidSkin` against `AvailableSkins`). Nothing
re-checks it in the match, so anyone who reaches the match without a lobby pass — a rejoin, a
mid-round join — brings whatever their GameInstance already held, which may be stale or duplicated.
That is the most likely remaining cause of a skin not matching, and it fits the reported symptom of
"terrible for players joining mid-round" that retired the previous system.
