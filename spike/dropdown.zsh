# sprig spike: validate a POSTDISPLAY-rendered dropdown driven by ZLE hooks.
# Usage: source spike/dropdown.zsh, then type `git ` and a few letters.

zmodload zsh/terminfo 2>/dev/null
autoload -Uz add-zle-hook-widget

typeset -ga _sprig_items=(
  "checkout:Switch branches or restore working tree files"
  "cherry-pick:Apply the changes introduced by some existing commits"
  "clone:Clone a repository into a new directory"
  "commit:Record changes to the repository"
  "config:Get and set repository or global options"
  "diff:Show changes between commits, commit and working tree"
  "fetch:Download objects and refs from another repository"
  "log:Show commit logs"
  "merge:Join two or more development histories together"
  "pull:Fetch from and integrate with another repository"
  "push:Update remote refs along with associated objects"
  "rebase:Reapply commits on top of another base tip"
  "reset:Reset current HEAD to the specified state"
  "status:Show the working tree status"
  "switch:Switch branches"
)
typeset -ga _sprig_matches=()
typeset -gi _sprig_sel=0 _sprig_visible=0 _sprig_prompt_col=0 _sprig_tok_start=0
typeset -g  _sprig_last_buffer=""
typeset -gi _sprig_max_rows=8

# Ask the terminal where the cursor is right after the prompt is drawn.
_sprig_line_init() {
  setopt localoptions extendedglob
  _sprig_prompt_col=0
  [[ -t 1 && -z $SPRIG_NO_DSR ]] || return
  local reply="" c
  print -n $'\e[6n' > /dev/tty
  while read -rs -k1 -t 0.2 c < /dev/tty; do
    reply+=$c
    [[ $reply == *$'\e['[0-9]##';'[0-9]##R ]] && break
  done
  if [[ $reply == (#b)(*)$'\e['([0-9]##)';'([0-9]##)R ]]; then
    _sprig_prompt_col=$(( match[3] - 1 ))
    reply=$match[1]
  fi
  # Keys typed while waiting for the response go back into the input queue.
  [[ -n $reply ]] && zle -U -- "$reply"
}

_sprig_clear() {
  POSTDISPLAY=""
  region_highlight=("${(@)region_highlight:#*memo=sprig*}")
  _sprig_visible=0
}

_sprig_render() {
  _sprig_clear
  (( ${#_sprig_matches} )) || return

  # Separate statements: zsh expands all typeset arguments before assigning any.
  local -i n=${#_sprig_matches}
  local -i rows=$(( n < _sprig_max_rows ? n : _sprig_max_rows ))
  local -i top=$(( _sprig_sel >= rows ? _sprig_sel - rows + 1 : 0 ))
  local -i namew=0 descw=0 width i
  local item name desc
  for item in "${_sprig_matches[@]}"; do
    name=${item%%:*}; (( ${#name} > namew )) && namew=${#name}
  done
  width=$(( COLUMNS - 2 < 60 ? COLUMNS - 2 : 60 ))
  descw=$(( width - namew - 4 ))

  # Line containing the cursor: chars before the token on that line.
  local before=${BUFFER[1,_sprig_tok_start]}
  local -i col=$(( ${#${before##*$'\n'}} ))
  [[ $before != *$'\n'* ]] && col+=_sprig_prompt_col
  (( col + width > COLUMNS - 1 )) && col=$(( COLUMNS - 1 - width ))
  (( col < 0 )) && col=0
  local pad=${(l:col:: :)}

  local text="" line
  local -i base=${#BUFFER} start
  local -a hl=()
  for (( i = top; i < top + rows; i++ )); do
    item=${_sprig_matches[i+1]}
    name=${item%%:*}; desc=${item#*:}
    (( descw > 0 )) && desc=${desc[1,descw]} || desc=""
    line=" ${(r:namew:: :)name}  ${(r:descw:: :)desc} "
    text+=$'\n'$pad
    start=$(( base + ${#text} ))
    text+=$line
    if (( i == _sprig_sel )); then
      hl+=("$start $(( start + ${#line} )) fg=0,bg=39,bold memo=sprig")
    else
      hl+=("$start $(( start + namew + 1 )) fg=255,bg=236 memo=sprig")
      hl+=("$(( start + namew + 1 )) $(( start + ${#line} )) fg=245,bg=236 memo=sprig")
    fi
  done
  if (( n > rows )); then
    line=" ↓ $(( n - top - rows )) more "
    text+=$'\n'$pad
    start=$(( base + ${#text} ))
    text+=$line
    hl+=("$start $(( start + ${#line} )) fg=242 memo=sprig")
  fi
  POSTDISPLAY=$text
  region_highlight+=("${hl[@]}")
  _sprig_visible=1
}

_sprig_update() {
  setopt localoptions extendedglob
  [[ $BUFFER == $_sprig_last_buffer ]] && return
  _sprig_last_buffer=$BUFFER
  _sprig_matches=() _sprig_sel=0

  local lbuf=$LBUFFER
  if [[ $lbuf == (#b)git[[:space:]]##([^[:space:]]#) ]]; then
    local q=$match[1]
    _sprig_tok_start=$(( ${#lbuf} - ${#q} ))
    local item
    for item in "${_sprig_items[@]}"; do
      [[ ${item%%:*} == ${q}* ]] && _sprig_matches+=($item)
    done
    # Hide when the token already equals the only match.
    (( ${#_sprig_matches} == 1 )) && [[ ${_sprig_matches[1]%%:*} == $q ]] && _sprig_matches=()
  fi
  _sprig_render
}

_sprig_pre_redraw() { _sprig_update }

_sprig_line_finish() { _sprig_clear; _sprig_last_buffer="" }

_sprig_down() {
  if (( _sprig_visible )); then
    _sprig_sel=$(( (_sprig_sel + 1) % ${#_sprig_matches} )); _sprig_render
  else
    zle .down-line-or-history
  fi
}

_sprig_up() {
  if (( _sprig_visible )); then
    _sprig_sel=$(( (_sprig_sel - 1 + ${#_sprig_matches}) % ${#_sprig_matches} )); _sprig_render
  else
    zle .up-line-or-history
  fi
}

_sprig_accept() {
  if (( _sprig_visible )); then
    local name=${_sprig_matches[_sprig_sel+1]%%:*}
    LBUFFER="${LBUFFER[1,_sprig_tok_start]}$name "
  else
    zle expand-or-complete
  fi
}

_sprig_dismiss() {
  _sprig_clear; _sprig_matches=()
}

zle -N _sprig_down; zle -N _sprig_up; zle -N _sprig_accept; zle -N _sprig_dismiss
add-zle-hook-widget line-init _sprig_line_init
add-zle-hook-widget line-pre-redraw _sprig_pre_redraw
add-zle-hook-widget line-finish _sprig_line_finish

() {
  local k
  for k in '^[[B' '^[OB' "${terminfo[kcud1]}" '^N'; do [[ -n $k ]] && bindkey "$k" _sprig_down; done
  for k in '^[[A' '^[OA' "${terminfo[kcuu1]}" '^P'; do [[ -n $k ]] && bindkey "$k" _sprig_up; done
  bindkey '^I' _sprig_accept
  bindkey '^[' _sprig_dismiss
}
