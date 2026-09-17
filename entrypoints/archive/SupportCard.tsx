import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heart, Coffee } from 'lucide-react';
import { cn } from '@/lib/utils';

export const GITHUB_REPO_URL = 'https://github.com/s3lm4n/submitlog';
export const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/vltge6001b';

function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      {...props}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

export interface SupportCardProps {
  className?: string;
  githubUrl?: string;
  buyMeACoffeeUrl?: string;
}

export function SupportCard({
  className,
  githubUrl = GITHUB_REPO_URL,
  buyMeACoffeeUrl = BUY_ME_A_COFFEE_URL,
}: SupportCardProps) {
  const hasCoffeeUrl = Boolean(buyMeACoffeeUrl && buyMeACoffeeUrl.trim().length > 0);

  return (
    <Card
      className={cn(
        'rounded-xl border border-border/70 bg-card/60 text-card-foreground p-5 sm:p-6 shadow-xs',
        className,
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-6">
        <div className="flex items-start gap-3.5">
          <div className="p-2 rounded-lg bg-secondary/60 text-muted-foreground shrink-0 mt-0.5">
            <Heart className="size-4 text-emerald-500" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground tracking-tight">
              Support SubmitLog
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
              SubmitLog is free, open source, and runs entirely on your device. If it saves you
              time, you can support its development.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 self-start sm:self-center">
          {githubUrl && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs gap-1.5 border-border/70 shadow-xs"
            >
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="SubmitLog on GitHub"
              >
                <GithubIcon className="size-3.5" />
                <span>GitHub</span>
              </a>
            </Button>
          )}

          {hasCoffeeUrl && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs gap-1.5 border-border/70 shadow-xs"
            >
              <a
                href={buyMeACoffeeUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Buy me a coffee"
              >
                <Coffee className="size-3.5 text-amber-500" />
                <span>Buy me a coffee</span>
              </a>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
