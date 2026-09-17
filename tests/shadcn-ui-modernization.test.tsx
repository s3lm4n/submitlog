import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { Badge } from '../src/components/ui/badge';
import { Button } from '../src/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../src/components/ui/card';
import { Input } from '../src/components/ui/input';
import { Separator } from '../src/components/ui/separator';
import { Skeleton } from '../src/components/ui/skeleton';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('shadcn/ui Modernization Architecture', () => {
  // 1. Badge variants
  it('Badge renders distinct variants for draft and saved states', () => {
    const draftHtml = renderToString(<Badge variant="draft">Draft</Badge>);
    expect(draftHtml).toContain('Draft');
    expect(draftHtml).toContain('amber');

    const savedHtml = renderToString(<Badge variant="saved">Saved</Badge>);
    expect(savedHtml).toContain('Saved');
    expect(savedHtml).toContain('emerald');

    const defaultHtml = renderToString(<Badge variant="default">Primary</Badge>);
    expect(defaultHtml).toContain('bg-primary');
  });

  // 2. Button variants
  it('Button renders appropriate variant and size classes', () => {
    const defaultBtn = renderToString(<Button variant="default">Capture</Button>);
    expect(defaultBtn).toContain('bg-primary');
    expect(defaultBtn).toContain('text-primary-foreground');

    const outlineBtn = renderToString(
      <Button variant="outline" size="sm">
        Outline
      </Button>,
    );
    expect(outlineBtn).toContain('border');
    expect(outlineBtn).toContain('h-8');

    const destructiveBtn = renderToString(<Button variant="destructive">Delete</Button>);
    expect(destructiveBtn).toContain('bg-destructive');
  });

  // 3. Card structure
  it('Card and subcomponents render semantic hierarchy', () => {
    const cardHtml = renderToString(
      <Card className="test-card">
        <CardHeader>
          <CardTitle>Test Form</CardTitle>
          <CardDescription>example.com</CardDescription>
        </CardHeader>
        <CardContent>3 answers ready</CardContent>
        <CardFooter>
          <Button size="sm">View</Button>
        </CardFooter>
      </Card>,
    );

    expect(cardHtml).toContain('test-card');
    expect(cardHtml).toContain('Test Form');
    expect(cardHtml).toContain('example.com');
    expect(cardHtml).toContain('3 answers ready');
  });

  // 4. Input and Separator
  it('Input and Separator render accessible attributes and classes', () => {
    const inputHtml = renderToString(
      <Input type="text" placeholder="Search..." aria-label="Search" />,
    );
    expect(inputHtml).toContain('placeholder="Search..."');
    expect(inputHtml).toContain('aria-label="Search"');
    expect(inputHtml).toContain('border-input');

    const sepHtml = renderToString(<Separator orientation="horizontal" />);
    expect(sepHtml).toContain('bg-border');
    expect(sepHtml).toContain('h-[1px]');
  });

  // 5. Skeleton loading
  it('Skeleton renders pulse animation for smooth loading states', () => {
    const skeletonHtml = renderToString(<Skeleton className="h-4 w-32" />);
    expect(skeletonHtml).toContain('animate-pulse');
    expect(skeletonHtml).toContain('bg-muted');
  });

  // 6. Source code audit: Popup architecture
  it('Popup source code satisfies design constraints and contains no obsolete toggles', () => {
    const popupSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/popup/Popup.tsx'),
      'utf-8',
    );

    // Must have SubmitLog header
    expect(popupSrc).toContain('SubmitLog');

    // Must have Archive link
    expect(popupSrc).toContain('openArchive');

    // Must have privacy footer
    expect(popupSrc).toContain('Stored locally. Nothing is uploaded.');

    // Must NOT have old autosave toggles
    expect(popupSrc).not.toContain('This session only');
    expect(popupSrc).not.toContain('Always on this site');
    expect(popupSrc).not.toContain('Clear draft');
  });

  // 7. Source code audit: Archive architecture
  it('Archive source code maintains distinct Draft vs Saved sections and uses AlertDialog', () => {
    const archiveSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/archive/Archive.tsx'),
      'utf-8',
    );

    // Distinct sections
    expect(archiveSrc).toContain('In progress');
    expect(archiveSrc).toContain('Saved submissions');

    // Uses AlertDialog for accessible deletions
    expect(archiveSrc).toContain('AlertDialog');
    expect(archiveSrc).toContain('Delete draft?');
    expect(archiveSrc).toContain('Delete saved submission?');

    // No window.confirm
    expect(archiveSrc).not.toContain('window.confirm');
  });

  // 8. Source code audit: Detail pages use AlertDialog for delete
  it('DraftDetail and SubmissionDetail use AlertDialog for delete confirmation', () => {
    const draftDetailSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/archive/DraftDetail.tsx'),
      'utf-8',
    );
    expect(draftDetailSrc).toContain('AlertDialog');
    expect(draftDetailSrc).toContain('Delete draft?');
    expect(draftDetailSrc).not.toContain('window.confirm');

    const subDetailSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/archive/SubmissionDetail.tsx'),
      'utf-8',
    );
    expect(subDetailSrc).toContain('AlertDialog');
    expect(subDetailSrc).toContain('Delete saved submission?');
    expect(subDetailSrc).not.toContain('window.confirm');
  });
});
