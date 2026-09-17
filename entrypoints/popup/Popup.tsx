import { useState, useEffect, useMemo, useCallback } from 'react';
import { browser } from 'wxt/browser';
import type { CapturedField, Submission, SubmissionRevision } from '../../src/models/submission';
import { SCHEMA_VERSION } from '../../src/models/submission';
import { generateId } from '../../src/utils/id';
import { createSubmissionRepository } from '../../src/storage/submission-repository';
import { createDraftRepository } from '../../src/storage/draft-repository';
import { normalizeDraftPathname } from '../../src/models/draft';
import {
  scanPageForms,
  capturePageForms,
  type InjectedScanResult,
  type InjectedCaptureResult,
  type InjectedDetectedField,
} from '../../src/capture/injected-capture';
import {
  injectedFillForm,
  type FillResult,
  type SavedAnswerToFill,
} from '../../src/capture/injected-fill';
import {
  mergeSubmissions,
  type MergePreview,
  type FieldDiff,
} from '../../src/matching/form-merger';
import { computeFormFingerprint } from '../../src/matching/form-fingerprint';
import {
  checkPrivateBrowsing,
  PRIVATE_BROWSING_MESSAGE,
} from '../../src/security/private-browsing-guard';
import { checkPageSupported, RESTRICTED_PAGE_MESSAGE } from '../../src/security/page-guard';
import { isGlobalEnabled, isSiteDisabled } from '../../src/storage/site-settings';
import { isBuiltInExcludedContext } from '../../src/security/page-exclusions';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  FileCheck2,
  Sparkles,
} from 'lucide-react';
import './popup.css';

type PopupState =
  | 'idle'
  | 'loading'
  | 'preview'
  | 'merge-preview'
  | 'saved'
  | 'error'
  | 'private-blocked'
  | 'restricted';

export function Popup() {
  const [state, setState] = useState<PopupState>('loading');
  const [isPaused, setIsPaused] = useState(false);
  const [isSiteBlocked, setIsSiteBlocked] = useState(false);
  const [hostname, setHostname] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [formDetected, setFormDetected] = useState(false);
  const [totalFields, setTotalFields] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [targetFrameId, setTargetFrameId] = useState(0);
  const [inaccessibleFrame, setInaccessibleFrame] = useState(false);
  const [currentDetectedFields, setCurrentDetectedFields] = useState<InjectedDetectedField[]>([]);

  // Saved match
  const [matchingSubmission, setMatchingSubmission] = useState<Submission | null>(null);
  const [fillFeedback, setFillFeedback] = useState<FillResult | null>(null);

  // Passive draft indication
  const [hasActiveDraft, setHasActiveDraft] = useState(false);

  // Capture & Merge
  const [capturedFields, setCapturedFields] = useState<CapturedField[]>([]);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [excludedCount, setExcludedCount] = useState(0);
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [savedSuccessMessage, setSavedSuccessMessage] = useState(
    'Your form data has been added to the archive.',
  );
  const [error, setError] = useState('');

  const repo = useMemo(() => createSubmissionRepository(), []);
  const draftRepo = useMemo(() => createDraftRepository(), []);

  const scanCurrentTab = useCallback(async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        setState('restricted');
        return;
      }

      // 1. Private / Incognito browsing safety check
      const privateCheck = checkPrivateBrowsing(tab);
      if (privateCheck.isPrivate) {
        setPageTitle('');
        setPageUrl('');
        setHostname('');
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setHasActiveDraft(false);
        setState('private-blocked');
        return;
      }

      // 2. Restricted browser internal page check
      const pageSupport = checkPageSupported(tab.url);
      if (!pageSupport.isSupported) {
        setState('restricted');
        return;
      }

      const url = new URL(tab.url);
      const origin = url.origin.toLowerCase();
      const normPath = normalizeDraftPathname(tab.url);

      setHostname(url.hostname);
      setPageTitle(tab.title || url.hostname);
      setPageUrl(tab.url);

      // 3. Global pause check
      const globalOn = await isGlobalEnabled();
      if (!globalOn) {
        setIsPaused(true);
        setIsSiteBlocked(false);
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setHasActiveDraft(false);
        setState('idle');
        return;
      }
      setIsPaused(false);

      // 4. Per-site disable check
      const siteOff = await isSiteDisabled(url.hostname);
      if (siteOff) {
        setIsSiteBlocked(true);
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setHasActiveDraft(false);
        setState('idle');
        return;
      }
      setIsSiteBlocked(false);

      // 5. Built-in excluded context check
      const excluded = isBuiltInExcludedContext({ hostname: url.hostname, pathname: url.pathname });
      if (excluded.isExcluded) {
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setHasActiveDraft(false);
        setState('idle');
        return;
      }

      // Scan all accessible frames within the tab
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: scanPageForms,
      });

      let bestFrameId = 0;
      let bestScan: InjectedScanResult | null = null;
      let anyInaccessible = false;

      if (results && results.length > 0) {
        for (const r of results) {
          const res = r.result as InjectedScanResult | undefined;
          if (!res) continue;
          if (res.inaccessibleFrameDetected) anyInaccessible = true;
          if (res.formDetected) {
            if (!bestScan || (res.score || 0) > (bestScan.score || 0)) {
              bestScan = res;
              bestFrameId = r.frameId ?? 0;
            }
          }
        }
      }

      setTargetFrameId(bestFrameId);

      if (bestScan && bestScan.formDetected) {
        setFormDetected(true);
        setTotalFields(bestScan.totalFields);
        setAnsweredCount(bestScan.answeredCount);
        setInaccessibleFrame(false);
        const detected = bestScan.detectedFields || [];
        setCurrentDetectedFields(detected);

        // Query IndexedDB for matching saved submission in Archive
        try {
          const match = await repo.findMatching(url.hostname, detected);
          setMatchingSubmission(match || null);
        } catch {
          setMatchingSubmission(null);
        }

        // Query active local draft for passive status indicator
        try {
          const fp = computeFormFingerprint(url.hostname, detected);
          const draft = await draftRepo.getByForm(origin, normPath, fp);
          setHasActiveDraft(Boolean(draft && Object.keys(draft.fields).length > 0));
        } catch {
          setHasActiveDraft(false);
        }
      } else {
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setInaccessibleFrame(anyInaccessible);
        setCurrentDetectedFields([]);
        setMatchingSubmission(null);
        setHasActiveDraft(false);
      }

      setState('idle');
    } catch {
      setState('restricted');
    }
  }, [repo, draftRepo]);

  useEffect(() => {
    scanCurrentTab();
  }, [scanCurrentTab]);

  useEffect(() => {
    const handleNotify = (msg: unknown) => {
      const message = msg as { type?: string; result?: { status?: string } };
      if (message?.type === 'SUBMITLOG_AUTOSAVE_NOTIFY') {
        if (message.result?.status === 'saved') {
          setHasActiveDraft(true);
          scanCurrentTab();
        }
      }
    };
    browser.runtime.onMessage.addListener(handleNotify);
    return () => {
      browser.runtime.onMessage.removeListener(handleNotify);
    };
  }, [scanCurrentTab]);

  async function toggleGlobalPause() {
    const next = !isPaused;
    setIsPaused(next);
    try {
      await browser.runtime.sendMessage({
        type: 'SUBMITLOG_SET_GLOBAL_ENABLED',
        payload: { enabled: !next },
      });
    } catch {
      // ignore
    }
    await scanCurrentTab();
  }

  async function toggleSiteDisable() {
    if (!hostname) return;
    const next = !isSiteBlocked;
    setIsSiteBlocked(next);
    try {
      await browser.runtime.sendMessage({
        type: 'SUBMITLOG_SET_SITE_DISABLED',
        payload: { hostname, disabled: next },
      });
    } catch {
      // ignore
    }
    await scanCurrentTab();
  }

  async function handleFill() {
    if (!matchingSubmission) return;
    setState('loading');

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setState('idle');
        return;
      }

      const savedAnswers: SavedAnswerToFill[] = matchingSubmission.fields
        .filter((f) => !f.excluded && f.value.trim() !== '')
        .map((f) => ({
          label: f.label,
          value: f.value,
          fieldType: f.fieldType,
        }));

      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [targetFrameId] },
        func: injectedFillForm,
        args: [{ savedAnswers }],
      });

      const fillRes = results?.[0]?.result as FillResult | undefined;
      if (fillRes) {
        setFillFeedback(fillRes);
      }

      // Re-scan tab to reflect newly filled fields
      await scanCurrentTab();
    } catch {
      setState('idle');
    }
  }

  async function handleCapture() {
    setState('loading');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        setState('restricted');
        return;
      }

      const privateCheck = checkPrivateBrowsing(tab);
      if (privateCheck.isPrivate) {
        setState('private-blocked');
        return;
      }

      const pageSupport = checkPageSupported(tab.url);
      if (!pageSupport.isSupported) {
        setState('restricted');
        return;
      }

      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [targetFrameId] },
        func: capturePageForms,
      });

      const captureResult = results?.[0]?.result as InjectedCaptureResult | undefined;
      if (!captureResult || !captureResult.fields) {
        setState('restricted');
        return;
      }

      const fields = captureResult.fields as unknown as CapturedField[];
      setCapturedFields(fields);
      setExcludedCount(captureResult.excludedCount);

      // If a matching saved submission exists in Archive, show Merge Preview
      if (matchingSubmission) {
        const preview = mergeSubmissions(matchingSubmission, fields);
        setMergePreview(preview);
        setState('merge-preview');
      } else {
        // Pre-select all non-excluded fields for direct save
        const selected = new Set<string>();
        fields.forEach((f: CapturedField) => {
          if (!f.excluded) selected.add(f.id);
        });
        setSelectedFields(selected);
        setState('preview');
      }
    } catch {
      setState('restricted');
    }
  }

  async function handleUpdateSaved() {
    if (!matchingSubmission || !mergePreview) return;

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (checkPrivateBrowsing(tab).isPrivate) {
        setState('private-blocked');
        return;
      }
    } catch {
      // Ignore query error, proceed
    }

    const revision: SubmissionRevision = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      fields: mergePreview.mergedFields,
      changeNote: `Updated (${mergePreview.changedCount} changed, ${mergePreview.newCount} new)`,
    };

    const updatedSubmission: Submission = {
      ...matchingSubmission,
      updatedAt: new Date().toISOString(),
      fields: mergePreview.mergedFields,
      revisions: [revision, ...(matchingSubmission.revisions || [])],
      schemaVersion: SCHEMA_VERSION,
    };

    try {
      await repo.save(updatedSubmission);
      setSavedSuccessMessage('Submission updated successfully.');
      setState('saved');
    } catch {
      setState('error');
      setError('Failed to update submission locally.');
    }
  }

  async function handleSaveAsNew() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (checkPrivateBrowsing(tab).isPrivate) {
        setState('private-blocked');
        return;
      }
    } catch {
      // Ignore query error, proceed
    }

    const fieldsToSave = capturedFields.filter((f) => !f.excluded && f.value.trim() !== '');
    const fingerprint = computeFormFingerprint(hostname, currentDetectedFields);

    const submission: Submission = {
      id: generateId(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageTitle,
      pageUrl,
      hostname,
      submissionTitle: `${pageTitle} - ${new Date().toLocaleDateString()}`,
      fields: fieldsToSave,
      captureVersion: '0.1.0',
      formFingerprint: fingerprint,
      revisions: [
        {
          id: generateId(),
          createdAt: new Date().toISOString(),
          fields: fieldsToSave,
          changeNote: 'Initial capture',
        },
      ],
    };

    try {
      await repo.save(submission);
      setSavedSuccessMessage('Saved as a new submission.');
      setState('saved');
    } catch {
      setState('error');
      setError('Failed to save submission locally.');
    }
  }

  async function handleDirectSave() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (checkPrivateBrowsing(tab).isPrivate) {
        setState('private-blocked');
        return;
      }
    } catch {
      // Ignore query error, proceed
    }

    const fieldsToSave = capturedFields.map((f) => ({
      ...f,
      excluded: f.excluded || !selectedFields.has(f.id),
      value: f.excluded || !selectedFields.has(f.id) ? '' : f.value,
    }));

    const nonExcluded = fieldsToSave.filter((f) => !f.excluded && f.value.trim() !== '');
    const fingerprint = computeFormFingerprint(hostname, currentDetectedFields);

    const submission: Submission = {
      id: generateId(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageTitle,
      pageUrl,
      hostname,
      submissionTitle: `${pageTitle} - ${new Date().toLocaleDateString()}`,
      fields: nonExcluded,
      captureVersion: '0.1.0',
      formFingerprint: fingerprint,
      revisions: [
        {
          id: generateId(),
          createdAt: new Date().toISOString(),
          fields: nonExcluded,
          changeNote: 'Initial capture',
        },
      ],
    };

    try {
      await repo.save(submission);
      setSavedSuccessMessage('Your form data has been added to the archive.');
      setState('saved');
    } catch {
      setState('error');
      setError('Failed to save submission locally.');
    }
  }

  function toggleField(id: string) {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openArchive() {
    const url = browser.runtime.getURL('/archive.html');
    browser.tabs.create({ url });
  }

  // Header component
  const Header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold tracking-tight text-foreground">SubmitLog</h1>
        {isPaused ? (
          <Badge
            variant="outline"
            className="text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10 text-[10px] font-medium px-1.5 py-0 h-4.5"
          >
            Paused
          </Badge>
        ) : isSiteBlocked ? (
          <Badge
            variant="outline"
            className="text-muted-foreground border-border text-[10px] font-medium px-1.5 py-0 h-4.5"
          >
            Site disabled
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium px-1.5 py-0 h-4.5"
          >
            Active
          </Badge>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={openArchive}
        className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <span>Archive</span>
        <ExternalLink className="size-3.5" />
      </Button>
    </div>
  );

  // Privacy footer component
  const PrivacyFooter = (
    <div className="flex items-center justify-center gap-1.5 pt-1 text-xs text-muted-foreground">
      <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      <span>Stored locally. Nothing is uploaded.</span>
    </div>
  );

  if (state === 'loading') {
    return (
      <div className="w-[430px] p-4 space-y-4">
        {Header}
        <Card className="p-4 space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-3 w-48" />
        </Card>
        <Skeleton className="h-9 w-full" />
        <Separator />
        {PrivacyFooter}
      </div>
    );
  }

  if (state === 'private-blocked') {
    return (
      <div className="w-[430px] p-4 space-y-4">
        {Header}
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <AlertCircle className="size-4" />
              Private Browsing Protected
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 text-xs text-muted-foreground leading-relaxed">
            {PRIVATE_BROWSING_MESSAGE}
          </CardContent>
        </Card>
        <Button onClick={() => window.close()} variant="secondary" className="w-full">
          Close
        </Button>
        <Separator />
        {PrivacyFooter}
      </div>
    );
  }

  if (state === 'restricted') {
    return (
      <div className="w-[430px] p-4 space-y-4">
        {Header}
        <Card className="border-muted bg-muted/20">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertCircle className="size-4 text-muted-foreground" />
              Page Not Supported
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 text-xs text-muted-foreground leading-relaxed">
            {RESTRICTED_PAGE_MESSAGE}
          </CardContent>
        </Card>
        <Button onClick={() => window.close()} variant="secondary" className="w-full">
          Close
        </Button>
        <Separator />
        {PrivacyFooter}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="w-[430px] p-4 space-y-4">
        {Header}
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-medium text-destructive flex items-center gap-2">
              <AlertCircle className="size-4" />
              Notice
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 text-xs text-muted-foreground">{error}</CardContent>
        </Card>
        <div className="flex gap-2">
          <Button onClick={() => window.close()} variant="secondary" className="flex-1">
            Close
          </Button>
          <Button onClick={openArchive} variant="default" className="flex-1">
            Archive
          </Button>
        </div>
        <Separator />
        {PrivacyFooter}
      </div>
    );
  }

  if (state === 'saved') {
    return (
      <div className="w-[430px] p-4 space-y-4 text-center">
        {Header}
        <Card className="p-6 space-y-2 bg-emerald-500/5 border-emerald-500/20">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-5" />
          </div>
          <CardTitle className="text-base font-semibold">Saved Successfully</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            {savedSuccessMessage}
          </CardDescription>
        </Card>
        <div className="flex gap-2">
          <Button onClick={openArchive} variant="default" className="flex-1">
            Open Archive
          </Button>
          <Button onClick={() => window.close()} variant="secondary" className="flex-1">
            Close
          </Button>
        </div>
        <Separator />
        {PrivacyFooter}
      </div>
    );
  }

  if (state === 'merge-preview' && mergePreview) {
    const significantDiffs = mergePreview.diffs.filter(
      (d) => d.status === 'changed' || d.status === 'newly_added',
    );

    return (
      <div className="w-[430px] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Update Saved Submission</h2>
            <p className="text-xs text-muted-foreground truncate max-w-[280px]">{hostname}</p>
          </div>
          <Badge variant="outline" className="text-xs">
            Diff Review
          </Badge>
        </div>

        <Card className="p-3 bg-muted/20 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {mergePreview.changedCount > 0 && (
              <Badge variant="default" className="text-[11px] h-5">
                {mergePreview.changedCount} changed
              </Badge>
            )}
            {mergePreview.newCount > 0 && (
              <Badge variant="saved" className="text-[11px] h-5">
                {mergePreview.newCount} new
              </Badge>
            )}
            {mergePreview.unchangedCount > 0 && (
              <Badge variant="secondary" className="text-[11px] h-5">
                {mergePreview.unchangedCount} unchanged
              </Badge>
            )}
            {mergePreview.blankPreservedCount > 0 && (
              <Badge variant="outline" className="text-[11px] h-5">
                {mergePreview.blankPreservedCount} blank preserved
              </Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground leading-tight">
            Blank current fields preserve previously saved answers non-destructively.
          </p>
        </Card>

        <ScrollArea className="h-56 rounded-md border p-2">
          {significantDiffs.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-6">
              All answered fields match your saved submission.
            </p>
          ) : (
            <div className="space-y-2">
              {significantDiffs.map((d: FieldDiff) => (
                <div key={d.id} className="rounded-md border p-2.5 space-y-1 bg-card">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">{d.label}</span>
                    <Badge
                      variant={d.status === 'changed' ? 'default' : 'saved'}
                      className="text-[10px] h-4 px-1.5"
                    >
                      {d.status === 'changed' ? 'Changed' : 'New'}
                    </Badge>
                  </div>
                  {d.status === 'changed' && (
                    <div className="text-xs text-muted-foreground line-through">
                      <span className="text-[10px] uppercase font-semibold mr-1">Old:</span>
                      {d.oldValue}
                    </div>
                  )}
                  <div className="text-xs text-foreground font-medium">
                    <span className="text-[10px] uppercase font-semibold text-muted-foreground mr-1">
                      {d.status === 'changed' ? 'New:' : 'Value:'}
                    </span>
                    {d.newValue}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="space-y-2">
          <Button onClick={handleUpdateSaved} variant="default" className="w-full">
            Update saved submission
          </Button>
          <div className="flex gap-2">
            <Button onClick={handleSaveAsNew} variant="secondary" className="flex-1">
              Save as new
            </Button>
            <Button onClick={() => setState('idle')} variant="outline" className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'preview') {
    const includedFields = capturedFields.filter((f) => !f.excluded);

    return (
      <div className="w-[430px] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Preview Data</h2>
            <p className="text-xs text-muted-foreground truncate max-w-[280px]">{hostname}</p>
          </div>
          <Badge variant="secondary" className="text-xs">
            {selectedFields.size} selected
          </Badge>
        </div>

        <ScrollArea className="h-60 rounded-md border p-2">
          {includedFields.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-8">
              No valid fields to capture.
            </p>
          ) : (
            <div className="space-y-2">
              {includedFields.map((f) => (
                <label
                  key={f.id}
                  className="flex items-start gap-2.5 p-2 rounded-md border bg-card hover:bg-accent/40 cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedFields.has(f.id)}
                    onChange={() => toggleField(f.id)}
                    className="mt-0.5 rounded border-input size-4 text-primary focus:ring-ring"
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="text-xs font-medium text-foreground leading-snug">
                      {f.label}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {f.value || <span className="italic text-muted-foreground/60">(empty)</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </ScrollArea>

        {excludedCount > 0 && (
          <p className="text-[11px] text-muted-foreground text-center">
            {excludedCount} sensitive {excludedCount === 1 ? 'field' : 'fields'} excluded for
            privacy.
          </p>
        )}

        <div className="flex gap-2">
          <Button onClick={() => setState('idle')} variant="outline" className="flex-1">
            Back
          </Button>
          <Button
            onClick={handleDirectSave}
            variant="default"
            className="flex-1"
            disabled={selectedFields.size === 0}
          >
            Save ({selectedFields.size})
          </Button>
        </div>
      </div>
    );
  }

  // Paused state
  if (isPaused) {
    return (
      <div className="w-[430px] p-4 space-y-4">
        {Header}

        <Card className="p-4 space-y-2 text-center bg-amber-500/5 border-amber-500/20">
          <CardTitle className="text-sm font-semibold text-foreground">
            SubmitLog is paused
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground leading-relaxed">
            SubmitLog is not reading or saving form fields. No form data is captured or autosaved
            while paused.
          </CardDescription>
        </Card>

        <div className="space-y-2">
          <Button onClick={toggleGlobalPause} variant="default" className="w-full font-medium">
            Resume SubmitLog
          </Button>
          <Button onClick={openArchive} variant="outline" className="w-full">
            Open Archive
          </Button>
        </div>

        <Separator />
        {PrivacyFooter}
      </div>
    );
  }

  // Site disabled state
  if (isSiteBlocked) {
    return (
      <div className="w-[430px] p-4 space-y-4">
        {Header}

        <Card className="p-4 space-y-2 text-center bg-muted/30 border-muted">
          <CardTitle className="text-xs font-mono font-medium text-muted-foreground truncate">
            {hostname}
          </CardTitle>
          <div className="text-sm font-semibold text-foreground">
            SubmitLog is disabled on this site
          </div>
          <CardDescription className="text-xs text-muted-foreground leading-relaxed">
            Form detection, autosave, and the pencil assistant are turned off for {hostname}.
          </CardDescription>
        </Card>

        <div className="space-y-2">
          <Button onClick={toggleSiteDisable} variant="default" className="w-full font-medium">
            Enable on this site
          </Button>
          <Button
            onClick={toggleGlobalPause}
            variant="ghost"
            className="w-full text-xs text-muted-foreground h-8"
          >
            Pause SubmitLog globally
          </Button>
        </div>

        <Separator />
        {PrivacyFooter}
      </div>
    );
  }

  // Idle state
  return (
    <div className="w-[430px] p-4 space-y-4">
      {Header}

      {fillFeedback && (
        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-xs text-emerald-800 dark:text-emerald-300">
          {fillFeedback.filledCount > 0 ? (
            <p className="leading-snug">
              ✓ Filled {fillFeedback.filledCount}{' '}
              {fillFeedback.filledCount === 1 ? 'field' : 'fields'}
              {fillFeedback.unmatchedSavedCount > 0 &&
                ` · ${fillFeedback.unmatchedSavedCount} saved answers had no matching field`}
              {fillFeedback.sensitiveSkippedCount > 0 &&
                ` · ${fillFeedback.sensitiveSkippedCount} sensitive field skipped`}
            </p>
          ) : (
            <p className="leading-snug">No matching fields found to fill.</p>
          )}
        </div>
      )}

      {!formDetected ? (
        <>
          <Card className="p-4 space-y-2 text-center bg-muted/20 border-muted">
            <CardTitle className="text-xs font-mono font-normal text-muted-foreground truncate">
              {hostname}
            </CardTitle>
            <CardDescription className="text-xs text-foreground/80 leading-relaxed">
              {inaccessibleFrame
                ? 'SubmitLog found an embedded form it cannot access with the current permission model.'
                : 'No meaningful submission form detected on this page.'}
            </CardDescription>
          </Card>

          <Button variant="default" className="w-full" disabled={true}>
            Capture submission
          </Button>
        </>
      ) : (
        <>
          <Card className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <CardTitle className="text-xs font-mono font-medium text-muted-foreground truncate">
                  {hostname}
                </CardTitle>
                <div className="text-sm font-semibold text-foreground mt-0.5">
                  {answeredCount > 0
                    ? `${answeredCount} ${answeredCount === 1 ? 'answer ready' : 'answers ready'}`
                    : `${totalFields} ${totalFields === 1 ? 'field detected' : 'fields detected'}`}
                </div>
              </div>
              {hasActiveDraft && (
                <Badge variant="draft" className="text-[11px] gap-1 shrink-0">
                  <Sparkles className="size-3" />
                  <span>Draft saved</span>
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{totalFields} total fields detected</span>
              {answeredCount > 0 && (
                <>
                  <span>·</span>
                  <span>{totalFields - answeredCount} blank</span>
                </>
              )}
            </div>

            {matchingSubmission && (
              <div className="rounded-md border bg-accent/40 p-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCheck2 className="size-4 text-primary shrink-0" />
                  <div className="min-w-0 text-xs">
                    <div className="font-medium text-foreground truncate">
                      Saved submission found
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Updated{' '}
                      {new Date(
                        matchingSubmission.updatedAt || matchingSubmission.createdAt,
                      ).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <Badge variant="saved" className="text-[10px] h-4.5 px-1.5 shrink-0">
                  Match
                </Badge>
              </div>
            )}
          </Card>

          <div className="space-y-2">
            {matchingSubmission && (
              <Button onClick={handleFill} variant="outline" className="w-full">
                Fill from saved answers
              </Button>
            )}

            <Button
              variant="default"
              className="w-full font-medium"
              onClick={handleCapture}
              disabled={answeredCount === 0}
            >
              {answeredCount === 0
                ? 'Capture answers (0)'
                : matchingSubmission
                  ? `Update saved submission (${answeredCount})`
                  : `Capture ${answeredCount} ${answeredCount === 1 ? 'answer' : 'answers'}`}
            </Button>
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-2 pt-1 text-xs">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleGlobalPause}
          className="h-7 text-xs text-muted-foreground hover:text-foreground px-2"
        >
          Pause SubmitLog
        </Button>
        {hostname && (
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSiteDisable}
            className="h-7 text-xs text-muted-foreground hover:text-foreground px-2"
          >
            Disable on this site
          </Button>
        )}
      </div>

      <Separator />
      {PrivacyFooter}
    </div>
  );
}
