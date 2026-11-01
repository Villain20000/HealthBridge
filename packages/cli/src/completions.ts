/**
 * Static shell completion scripts. The emitted scripts embed fixed
 * command/flag lists and never execute the CLI (or anything else) at
 * completion time — no `$(healthbridge …)` calls, no eval of tool output.
 */

export const COMPLETION_SHELLS = ["bash", "zsh"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

const COMMANDS = [
  "adapters",
  "completions",
  "demo",
  "doctor",
  "examples",
  "formats",
  "help",
  "init",
  "inspect",
  "plugins",
  "reproduce",
  "trace",
  "transform",
  "validate",
].join(" ");

const FLAGS = [
  "--adapter",
  "--delimiter",
  "--dir",
  "--encoding",
  "--fail-on",
  "--filename",
  "--force",
  "--format",
  "--help",
  "--imported-at",
  "--input",
  "--json",
  "--mapping",
  "--max-records",
  "--out",
  "--profile",
  "--records",
  "--run-bundle",
  "--seed",
  "--standard",
].join(" ");

function renderBash(): string {
  return `# HealthBridge OS shell completion (bash).
# Static command/flag lists — this script never executes the CLI at completion time.
# Install: healthbridge completions bash >> ~/.bash_completion
_healthbridge_commands="${COMMANDS}"
_healthbridge_flags="${FLAGS}"
_healthbridge_comp() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]:-}"
  case "$prev" in
    --delimiter) COMPREPLY=($(compgen -W "comma semicolon tab pipe" -- "$cur")); return 0 ;;
    --encoding) COMPREPLY=($(compgen -W "utf-8 utf-16le windows-1252" -- "$cur")); return 0 ;;
    --format) COMPREPLY=($(compgen -W "json ndjson" -- "$cur")); return 0 ;;
    --standard) COMPREPLY=($(compgen -W "fhir-r4" -- "$cur")); return 0 ;;
    --fail-on) COMPREPLY=($(compgen -W "warning" -- "$cur")); return 0 ;;
    completions) COMPREPLY=($(compgen -W "bash zsh" -- "$cur")); return 0 ;;
  esac
  COMPREPLY=($(compgen -W "$_healthbridge_commands $_healthbridge_flags" -- "$cur"))
  return 0
}
complete -F _healthbridge_comp healthbridge
`;
}

function renderZsh(): string {
  return `#compdef healthbridge
# HealthBridge OS shell completion (zsh).
# Static command/flag lists — this script never executes the CLI at completion time.
# Install: healthbridge completions zsh > ~/.zsh/completions/_healthbridge (then compinit)
_healthbridge() {
  local -a commands
  commands=(
    'doctor:Probe the environment, adapters and a self-test'
    'init:Scaffold a project (config + starter mapping)'
    'formats:List registered adapters and capabilities'
    'inspect:Inspect a medical dataset'
    'transform:Transform a dataset into FHIR R4'
    'validate:Validate a FHIR R4 resource'
    'trace:Render a trace report'
    'reproduce:Re-run a stored run bundle'
    'demo:Generate deterministic synthetic data'
    'plugins:List adapters (built-in + installed)'
    'examples:List bundled examples and datasets'
    'completions:Print a static shell completion script'
    'adapters:Alias of formats list'
    'help:Show help'
  )
  _arguments -C \\
    '1: :->command' \\
    '*: :->args' && return 0
  case $state in
    command)
      _describe -t commands 'healthbridge commands' commands && return 0
      ;;
    args)
      case $words[2] in
        transform|inspect)
          _arguments \\
            '--mapping[Mapping definition]:file:_files' \\
            '--adapter[Force a specific adapter]:adapter: ' \\
            '--max-records[Limit processed records]:count: ' \\
            '--delimiter[Override CSV delimiter]:delimiter:(comma semicolon tab pipe)' \\
            '--encoding[Override input encoding]:encoding:(utf-8 utf-16le windows-1252)' \\
            '--out[Write output to a file]:file:_files' \\
            '--format[Output serialisation]:format:(json ndjson)' \\
            '--imported-at[Pin the provenance timestamp]:timestamp: ' \\
            '--run-bundle[Write a run bundle]:file:_files' \\
            '--fail-on[Exit non-zero on warnings]:level:(warning)' \\
            '--filename[Filename for stdin input]:name: ' \\
            '--json[Machine-readable output]' \\
            '--help[Show this help]'
          ;;
        completions)
          _describe -t shells 'completion shells' '(bash:bash zsh:zsh)' && return 0
          ;;
        validate)
          _arguments \\
            '--standard[Validation standard]:standard:(fhir-r4)' \\
            '--json[Machine-readable output]' \\
            '--help[Show this help]'
          ;;
        *)
          _arguments \\
            '--json[Machine-readable output]' \\
            '--help[Show this help]'
          ;;
      esac
      ;;
  esac
}
_healthbridge
`;
}

/** Render the static completion script for `shell`, or `undefined` when unsupported. */
export function renderCompletion(shell: string): string | undefined {
  if (shell === "bash") return renderBash();
  if (shell === "zsh") return renderZsh();
  return undefined;
}
