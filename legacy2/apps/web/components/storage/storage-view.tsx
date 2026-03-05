"use client"

import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type {
  ListStorageKvResult,
  QueryStorageSqlResult,
  StorageDirectoryEntry,
} from "@executor-v2/management-api/storage/api"
import type {
  StorageDurability,
  StorageInstance,
  StorageScopeType,
} from "@executor-v2/schema"
import type { ChangeEvent, FormEvent } from "react"
import { useEffect, useMemo, useState } from "react"

import { useWorkspace } from "../../lib/hooks/use-workspace"
import {
  closeStorageInstance,
  listStorageDirectory,
  listStorageKv,
  openStorageInstance,
  queryStorageSql,
  readStorageFile,
  removeStorageInstance,
  storageByWorkspace,
  toCloseStorageRequest,
  toListStorageDirectoryPayload,
  toListStorageKvPayload,
  toOpenStoragePayload,
  toOpenStorageRequest,
  toQueryStorageSqlPayload,
  toReadStorageFilePayload,
  toRemoveStorageRequest,
  toStorageRemoveResult,
} from "../../lib/control-plane/atoms"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Input } from "../ui/input"
import { Select } from "../ui/select"
import { cn, formatTimestamp } from "../../lib/utils"
import { matchState } from "../shared/match-state"
import { PageHeader } from "../shared/page-header"
import { StatusMessage } from "../shared/status-message"

type BusyId = StorageInstance["id"] | "create"
type StatusVariant = "info" | "error"

const storageStatusBadgeVariant = (
  status: string,
): "outline" | "approved" | "pending" | "denied" => {
  if (status === "active") return "approved"
  if (status === "pending") return "pending"
  if (status === "error" || status === "failed") return "denied"
  return "outline"
}

const toStatusVariant = (message: string | null): StatusVariant =>
  message !== null && /failed|error/.test(message.toLowerCase()) ? "error" : "info"

export default function StorageView() {
  const { workspaceId } = useWorkspace()

  const [storageScopeType, setStorageScopeType] = useState<StorageScopeType>("scratch")
  const [storageDurability, setStorageDurability] = useState<StorageDurability>("ephemeral")
  const [storageProvider, setStorageProvider] =
    useState<StorageInstance["provider"]>("agentfs-local")
  const [storagePurposeInput, setStoragePurposeInput] = useState("")
  const [storageTtlHoursInput, setStorageTtlHoursInput] = useState("24")
  const [storageAccountIdInput, setStorageAccountIdInput] = useState("")
  const [storageSearchQuery, setStorageSearchQuery] = useState("")
  const [storageStatusText, setStorageStatusText] = useState<string | null>(null)
  const [storageStatusVariant, setStorageStatusVariant] = useState<StatusVariant>("info")

  const [storageBusyId, setStorageBusyId] = useState<BusyId | null>(null)
  const [storageSelectedId, setStorageSelectedId] = useState<StorageInstance["id"] | null>(
    null,
  )

  const [storageDirectoryPath, setStorageDirectoryPath] = useState("/")
  const [storageDirectoryEntries, setStorageDirectoryEntries] = useState<
    ReadonlyArray<StorageDirectoryEntry>
  >([])
  const [storageDirectoryBusy, setStorageDirectoryBusy] = useState(false)

  const [storageFilePreviewPath, setStorageFilePreviewPath] = useState<string | null>(null)
  const [storageFilePreviewContent, setStorageFilePreviewContent] = useState("")
  const [storageFilePreviewBusy, setStorageFilePreviewBusy] = useState(false)

  const [storageKvPrefix, setStorageKvPrefix] = useState("")
  const [storageKvLimit, setStorageKvLimit] = useState("100")
  const [storageKvItems, setStorageKvItems] = useState<
    ReadonlyArray<ListStorageKvResult["items"][number]>
  >([])
  const [storageKvBusy, setStorageKvBusy] = useState(false)

  const [storageSqlText, setStorageSqlText] = useState("SELECT name FROM sqlite_master LIMIT 50")
  const [storageSqlMaxRows, setStorageSqlMaxRows] = useState("200")
  const [storageSqlResult, setStorageSqlResult] = useState<QueryStorageSqlResult | null>(
    null,
  )
  const [storageSqlBusy, setStorageSqlBusy] = useState(false)

  const storageState = useAtomValue(storageByWorkspace(workspaceId))
  const runOpenStorageInstance = useAtomSet(openStorageInstance, { mode: "promise" })
  const runCloseStorageInstance = useAtomSet(closeStorageInstance, { mode: "promise" })
  const runRemoveStorageInstance = useAtomSet(removeStorageInstance, { mode: "promise" })
  const runListStorageDirectory = useAtomSet(listStorageDirectory, { mode: "promise" })
  const runReadStorageFile = useAtomSet(readStorageFile, { mode: "promise" })
  const runListStorageKv = useAtomSet(listStorageKv, { mode: "promise" })
  const runQueryStorageSql = useAtomSet(queryStorageSql, { mode: "promise" })

  const storageItems = storageState.items

  const filteredStorageItems = useMemo(() => {
    const query = storageSearchQuery.trim().toLowerCase()
    if (query.length === 0) {
      return storageItems
    }

    return storageItems.filter((instance) => {
      const fields = [
        instance.id,
        instance.scopeType,
        instance.durability,
        instance.status,
        instance.provider,
        instance.backendKey,
        instance.purpose,
      ]

      return fields
        .filter((value): value is string => value !== null)
        .some((value) => value.toLowerCase().includes(query))
    })
  }, [storageItems, storageSearchQuery])

  const selectedStorageInstance = useMemo(() => {
    if (storageItems.length === 0) {
      return null
    }

    if (storageSelectedId === null) {
      return storageItems[0]
    }

    return storageItems.find((instance) => instance.id === storageSelectedId) ?? storageItems[0]
  }, [storageItems, storageSelectedId])

  const resetInspectorState = () => {
    setStorageDirectoryPath("/")
    setStorageDirectoryEntries([])
    setStorageFilePreviewPath(null)
    setStorageFilePreviewContent("")
    setStorageKvItems([])
    setStorageKvPrefix("")
    setStorageKvLimit("100")
    setStorageSqlText("SELECT name FROM sqlite_master LIMIT 50")
    setStorageSqlMaxRows("200")
    setStorageSqlResult(null)
  }

  useEffect(() => {
    setStorageStatusText(null)
    setStorageStatusVariant("info")
    setStorageBusyId(null)
    setStorageSelectedId(null)
    resetInspectorState()
  }, [workspaceId])

  useEffect(() => {
    if (storageItems.length === 0) {
      if (storageSelectedId !== null) {
        setStorageSelectedId(null)
      }
      return
    }

    const foundSelected =
      storageSelectedId !== null &&
      storageItems.some((instance) => instance.id === storageSelectedId)
    if (!foundSelected) {
      setStorageSelectedId(storageItems[0]?.id ?? null)
      return
    }
  }, [storageItems, storageSelectedId])

  const setInfoStatus = (message: string | null) => {
    setStorageStatusText(message)
    setStorageStatusVariant(toStatusVariant(message))
  }

  const setErrorStatus = (message: string) => {
    setStorageStatusText(message)
    setStorageStatusVariant("error")
  }

  const handleOpenStorage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (storageBusyId !== null) {
      return
    }

    const purpose = storagePurposeInput.trim()
    const accountId = storageAccountIdInput.trim()
    const ttlHours = Number.parseInt(storageTtlHoursInput, 10)

    if (storageScopeType === "account" && accountId.length === 0) {
      setErrorStatus("Account scope storage requires account id.")
      return
    }

    if (storageDurability === "ephemeral" && (!Number.isFinite(ttlHours) || ttlHours <= 0)) {
      setErrorStatus("Ephemeral storage requires a positive TTL in hours.")
      return
    }

    setStorageBusyId("create")

    void runOpenStorageInstance(
      toOpenStorageRequest({
        workspaceId,
        payload: toOpenStoragePayload({
          scopeType: storageScopeType,
          durability: storageDurability,
          provider: storageProvider,
          purpose: purpose.length > 0 ? purpose : undefined,
          ttlHours: storageDurability === "ephemeral" ? ttlHours : undefined,
          accountId:
            storageScopeType === "account"
              ? (accountId as Exclude<StorageInstance["accountId"], null>)
              : undefined,
        }),
      }),
    )
      .then((storageInstance) => {
        setStorageSelectedId(storageInstance.id)
        setStoragePurposeInput("")
        setStorageTtlHoursInput("24")
        setStorageAccountIdInput("")
        setInfoStatus(`Opened storage instance ${storageInstance.id}.`)
        resetInspectorState()
      })
      .catch(() => {
        setErrorStatus("Storage open failed.")
      })
      .finally(() => {
        setStorageBusyId(null)
      })
  }

  const handleCloseStorage = (storageInstanceId: StorageInstance["id"]) => {
    if (storageBusyId !== null) {
      return
    }

    setStorageBusyId(storageInstanceId)

    void runCloseStorageInstance(toCloseStorageRequest({ workspaceId, storageInstanceId }))
      .then(() => {
        setInfoStatus("Storage instance closed.")
      })
      .catch(() => {
        setErrorStatus("Storage close failed.")
      })
      .finally(() => {
        setStorageBusyId(null)
      })
  }

  const handleRemoveStorage = (storageInstanceId: StorageInstance["id"]) => {
    if (storageBusyId !== null) {
      return
    }

    setStorageBusyId(storageInstanceId)

    void runRemoveStorageInstance(toRemoveStorageRequest({ workspaceId, storageInstanceId }))
      .then((result) => {
        const removed = toStorageRemoveResult(result)
        setInfoStatus(
          removed
            ? `Storage instance ${storageInstanceId} removed.`
            : "Storage instance not found.",
        )
        if (storageSelectedId === storageInstanceId) {
          setStorageSelectedId(null)
          resetInspectorState()
        }
      })
      .catch(() => {
        setErrorStatus("Storage removal failed.")
      })
      .finally(() => {
        setStorageBusyId(null)
      })
  }

  const handleSelectStorageInstance = (storageInstanceId: StorageInstance["id"]) => {
    setStorageSelectedId(storageInstanceId)
    resetInspectorState()
  }

  const handleListStorageDirectory = (nextPath?: string) => {
    if (selectedStorageInstance === null || storageDirectoryBusy) {
      return
    }

    const pathInput = (nextPath ?? storageDirectoryPath).trim()
    const normalizedPath = pathInput.length > 0 ? pathInput : "/"
    setStorageDirectoryBusy(true)

    void runListStorageDirectory({
      path: { workspaceId, storageInstanceId: selectedStorageInstance.id },
      payload: toListStorageDirectoryPayload({
        path: normalizedPath,
      }),
    })
      .then((directory) => {
        setStorageDirectoryPath(directory.path)
        setStorageDirectoryEntries(directory.entries)
        setInfoStatus(`Loaded directory ${directory.path}.`)
      })
      .catch(() => {
        setErrorStatus("Directory listing failed.")
      })
      .finally(() => {
        setStorageDirectoryBusy(false)
      })
  }

  const handleReadStorageFile = (filePath: string) => {
    if (selectedStorageInstance === null || storageFilePreviewBusy) {
      return
    }

    setStorageFilePreviewBusy(true)

    void runReadStorageFile({
      path: { workspaceId, storageInstanceId: selectedStorageInstance.id },
      payload: toReadStorageFilePayload({
        path: filePath,
        encoding: "utf8",
      }),
    })
      .then((fileResult) => {
        setStorageFilePreviewPath(fileResult.path)
        setStorageFilePreviewContent(fileResult.content)
        setInfoStatus(`Loaded file ${fileResult.path}.`)
      })
      .catch(() => {
        setErrorStatus("File read failed.")
      })
      .finally(() => {
        setStorageFilePreviewBusy(false)
      })
  }

  const handleListStorageKv = () => {
    if (selectedStorageInstance === null || storageKvBusy) {
      return
    }

    const parsedLimit = Number.parseInt(storageKvLimit, 10)
    setStorageKvBusy(true)

    void runListStorageKv({
      path: { workspaceId, storageInstanceId: selectedStorageInstance.id },
      payload: toListStorageKvPayload({
        prefix: storageKvPrefix.trim(),
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      }),
    })
      .then((kvResult) => {
        setStorageKvItems(kvResult.items)
        setInfoStatus(`Loaded ${kvResult.items.length} KV entries.`)
      })
      .catch(() => {
        setErrorStatus("KV listing failed.")
      })
      .finally(() => {
        setStorageKvBusy(false)
      })
  }

  const handleQueryStorageSql = () => {
    if (selectedStorageInstance === null || storageSqlBusy) {
      return
    }

    const sql = storageSqlText.trim()
    const maxRows = Number.parseInt(storageSqlMaxRows, 10)

    if (sql.length === 0) {
      setErrorStatus("SQL query is required.")
      return
    }

    setStorageSqlBusy(true)

    void runQueryStorageSql({
      path: { workspaceId, storageInstanceId: selectedStorageInstance.id },
      payload: toQueryStorageSqlPayload({
        sql,
        maxRows: Number.isFinite(maxRows) ? maxRows : undefined,
      }),
    })
      .then((sqlResult) => {
        setStorageSqlResult(sqlResult)
        setInfoStatus("SQL query executed.")
      })
      .catch(() => {
        setErrorStatus("SQL query failed.")
      })
      .finally(() => {
        setStorageSqlBusy(false)
      })
  }

  const isWorking = storageBusyId !== null
  const selectedTargetId = selectedStorageInstance?.id ?? ""

  return (
    <section className="space-y-4">
      <PageHeader
        title="Storage"
        description="Open workspace storage and inspect files, KV pairs, and SQL state in one place."
      />

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="border-border/70">
          <CardHeader className="pb-3">
            <CardTitle>Open Storage Instance</CardTitle>
            <CardDescription>
              Provision workspace storage for files, KV, and SQLite workloads.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form className="space-y-3" onSubmit={handleOpenStorage}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="storage-scope">
                    Scope
                  </label>
                  <Select
                    id="storage-scope"
                    value={storageScopeType}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                      setStorageScopeType(event.target.value as StorageScopeType)
                    }
                    disabled={isWorking}
                  >
                    <option value="scratch">scratch</option>
                    <option value="workspace">workspace</option>
                    <option value="organization">organization</option>
                    <option value="account">account</option>
                  </Select>
                </div>

                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="storage-durability">
                    Durability
                  </label>
                  <Select
                    id="storage-durability"
                    value={storageDurability}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                      setStorageDurability(event.target.value as StorageDurability)
                    }
                    disabled={isWorking}
                  >
                    <option value="ephemeral">ephemeral</option>
                    <option value="durable">durable</option>
                  </Select>
                </div>
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="storage-provider">
                  Provider
                </label>
                <Select
                  id="storage-provider"
                  value={storageProvider}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setStorageProvider(event.target.value as StorageInstance["provider"])
                  }
                  disabled={isWorking}
                >
                  <option value="agentfs-local">agentfs-local</option>
                  <option value="agentfs-cloudflare">agentfs-cloudflare</option>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="storage-purpose">
                  Purpose (optional)
                </label>
                <Input
                  id="storage-purpose"
                  value={storagePurposeInput}
                  onChange={(event) => setStoragePurposeInput(event.target.value)}
                  placeholder="tool execution workspace"
                  disabled={isWorking}
                />
              </div>

              {storageDurability === "ephemeral" ? (
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="storage-ttl-hours">
                    TTL hours
                  </label>
                  <Input
                    id="storage-ttl-hours"
                    value={storageTtlHoursInput}
                    onChange={(event) => setStorageTtlHoursInput(event.target.value)}
                    placeholder="24"
                    inputMode="numeric"
                    disabled={isWorking}
                  />
                </div>
              ) : null}

              {storageScopeType === "account" ? (
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="storage-account-id">
                    Account id
                  </label>
                  <Input
                    id="storage-account-id"
                    value={storageAccountIdInput}
                    onChange={(event) => setStorageAccountIdInput(event.target.value)}
                    placeholder="acct_123"
                    required
                    disabled={isWorking}
                  />
                </div>
              ) : null}

              <Button type="submit" disabled={isWorking}>
                {storageBusyId === "create" ? "Opening..." : "Open Storage"}
              </Button>
            </form>

            <StatusMessage message={storageStatusText} variant={storageStatusVariant} />
          </CardContent>
        </Card>

        <Card className="border-border/70">
          <CardHeader className="pb-3">
            <CardTitle>Storage Instances</CardTitle>
            <CardDescription>Inspect and manage active workspace storage instances.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="storage-search">
                Search
              </label>
              <Input
                id="storage-search"
                value={storageSearchQuery}
                onChange={(event) => setStorageSearchQuery(event.target.value)}
                placeholder="scope, durability, status, provider"
              />
            </div>

            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="storage-selected-target">
                Inspector target
              </label>
              <Select
                id="storage-selected-target"
                value={selectedTargetId}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  handleSelectStorageInstance(event.target.value as StorageInstance["id"])
                }
                disabled={filteredStorageItems.length === 0 || isWorking}
              >
                {filteredStorageItems.length === 0 ? (
                  <option value="">No storage instances</option>
                ) : (
                  filteredStorageItems.map((storageInstance) => (
                    <option key={storageInstance.id} value={storageInstance.id}>
                      {storageInstance.id}
                    </option>
                  ))
                )}
              </Select>
            </div>

            <StatusMessage message={storageStatusText} variant={storageStatusVariant} />

            {matchState(storageState, {
              loading: "Loading storage...",
              empty:
                storageSearchQuery.length > 0
                  ? "No storage instances match this search."
                  : "No storage instances found.",
              filteredCount: filteredStorageItems.length,
              ready: () => (
                <div className="space-y-2">
                  {filteredStorageItems.map((storageInstance) => {
                    const busy = storageBusyId === storageInstance.id
                    return (
                      <div
                        key={storageInstance.id}
                        className={cn(
                          "rounded-lg border border-border bg-background/70 p-3",
                          busy && "opacity-80",
                        )}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-1">
                            <p className="truncate text-sm font-medium">{storageInstance.id}</p>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <Badge variant="outline">{storageInstance.scopeType}</Badge>
                              <Badge variant="outline">{storageInstance.durability}</Badge>
                              <Badge variant={storageStatusBadgeVariant(storageInstance.status)}>
                                {storageInstance.status}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              provider {storageInstance.provider}
                            </p>
                            <p className="break-all text-xs text-muted-foreground">
                              backend {storageInstance.backendKey}
                            </p>
                            {storageInstance.purpose ? (
                              <p className="break-all text-xs text-muted-foreground">
                                purpose {storageInstance.purpose}
                              </p>
                            ) : null}
                            <p className="text-xs text-muted-foreground">
                              updated {formatTimestamp(storageInstance.updatedAt)}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleSelectStorageInstance(storageInstance.id)}
                              disabled={isWorking}
                            >
                              Inspect
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleCloseStorage(storageInstance.id)}
                              disabled={isWorking || storageInstance.status !== "active"}
                            >
                              Close
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={() => handleRemoveStorage(storageInstance.id)}
                              disabled={isWorking}
                            >
                              {busy ? "Removing..." : "Remove"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ),
            })}

            {selectedStorageInstance ? (
              <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex flex-col gap-3 border-b border-dashed border-border pb-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">Inspector {selectedStorageInstance.id}</p>
                    <p className="text-xs text-muted-foreground">
                      {selectedStorageInstance.scopeType}/{selectedStorageInstance.durability} ·
                      {selectedStorageInstance.status}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleListStorageDirectory()}
                      disabled={storageDirectoryBusy}
                    >
                      {storageDirectoryBusy ? "Loading..." : "Load Directory"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleListStorageDirectory(storageDirectoryPath)}
                      disabled={storageDirectoryBusy}
                    >
                      Open Path
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Directory browser</p>
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Input
                      value={storageDirectoryPath}
                      onChange={(event) => setStorageDirectoryPath(event.target.value)}
                      placeholder="/"
                      disabled={storageDirectoryBusy}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleListStorageDirectory(storageDirectoryPath.trim())}
                      disabled={storageDirectoryBusy}
                    >
                      Open Path
                    </Button>
                  </div>
                  <div className="max-h-52 space-y-1 overflow-auto rounded-md border border-border bg-background/70 p-2">
                    {storageDirectoryEntries.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No directory entries loaded.</p>
                    ) : (
                      storageDirectoryEntries.map((entry) => {
                        const isFile = entry.kind === "file"
                        return (
                          <div
                            key={`${entry.path}:${entry.kind}`}
                            className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium">{entry.name}</p>
                              <p className="truncate text-[11px] text-muted-foreground">{entry.path}</p>
                            </div>
                            {isFile ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => handleReadStorageFile(entry.path)}
                                disabled={storageFilePreviewBusy}
                              >
                                {storageFilePreviewBusy ? "Reading..." : "Read"}
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => handleListStorageDirectory(entry.path)}
                                disabled={storageDirectoryBusy}
                              >
                                Open
                              </Button>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">File preview</p>
                  <p className="text-xs text-muted-foreground">
                    path {storageFilePreviewPath ?? "-"}
                  </p>
                  <pre className="max-h-40 overflow-auto rounded-md border border-border bg-background/70 p-2 text-[11px] leading-5 text-muted-foreground">
                    {storageFilePreviewContent.length > 0
                      ? storageFilePreviewContent
                      : "No file loaded."}
                  </pre>
                </div>

                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">KV browser</p>
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <Input
                      value={storageKvPrefix}
                      onChange={(event) => setStorageKvPrefix(event.target.value)}
                      placeholder="KV prefix"
                      disabled={storageKvBusy}
                    />
                    <Input
                      value={storageKvLimit}
                      onChange={(event) => setStorageKvLimit(event.target.value)}
                      placeholder="100"
                      inputMode="numeric"
                      disabled={storageKvBusy}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleListStorageKv}
                      disabled={storageKvBusy}
                    >
                      {storageKvBusy ? "Loading..." : "Load KV"}
                    </Button>
                  </div>
                  <pre className="max-h-40 overflow-auto rounded-md border border-border bg-background/70 p-2 text-[11px] leading-5 text-muted-foreground">
                    {JSON.stringify(storageKvItems, null, 2)}
                  </pre>
                </div>

                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">SQL console</p>
                  <textarea
                    className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs"
                    value={storageSqlText}
                    onChange={(event) => setStorageSqlText(event.target.value)}
                    disabled={storageSqlBusy}
                  />
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Input
                      value={storageSqlMaxRows}
                      onChange={(event) => setStorageSqlMaxRows(event.target.value)}
                      inputMode="numeric"
                      placeholder="200"
                      disabled={storageSqlBusy}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleQueryStorageSql}
                      disabled={storageSqlBusy}
                    >
                      {storageSqlBusy ? "Running..." : "Run SQL"}
                    </Button>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-md border border-border bg-background/70 p-2 text-[11px] leading-5 text-muted-foreground">
                    {storageSqlResult === null
                      ? "No SQL result yet."
                      : JSON.stringify(storageSqlResult, null, 2)}
                  </pre>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
