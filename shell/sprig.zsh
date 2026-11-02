# sprig: Fig-style autocomplete for zsh.
#
# Loaded by `eval "$(sprig init zsh)"`, which defines _sprig_cmd (how to run
# sprig) and _sprig_sock (daemon socket) before this file.
#
# The dropdown is drawn with POSTDISPLAY (text after the buffer) and colored
# with region_highlight, so zle itself handles layout, scrolling and cleanup.

[[ -o interactive && -o zle ]] || return 0
autoload -Uz is-at-least
is-at-least 5.3 || return 0
zmodload zsh/net/socket zsh/terminfo zsh/datetime 2>/dev/null || return 0
autoload -Uz add-zle-hook-widget

typeset -gi _sprig_fd=-1 _sprig_id=0 _sprig_shown_id=-1 _sprig_visible=0 _sprig_sel=0 _sprig_navigated=0
typeset -gi _sprig_replace_len=0 _sprig_prompt_col=0 _sprig_dismissed_at=-1 _sprig_failures=0
typeset -g  _sprig_sent="" _sprig_spec=""
typeset -ga _sprig_disp=() _sprig_ins=() _sprig_desc=() _sprig_kind=() _sprig_hl=()
typeset -gi _sprig_max_rows=${SPRIG_MAX_ROWS:-8}
typeset -gi _sprig_memo=0
is-at-least 5.9 && _sprig_memo=1

typeset -gA _sprig_icon=(
  subcommand '›' option '-' folder '▸' file '·' arg '•' special '★'
)
typeset -gA _sprig_icon_color=(
  subcommand 75 option 179 folder 110 file 250 arg 114 special 213
)

# SPRIG_DEBUG=/path/to/log traces requests and replies.
_sprig_dbg() { [[ -n $SPRIG_DEBUG ]] && print -r -- "$EPOCHREALTIME $*" >> $SPRIG_DEBUG }

# --- daemon connection -------------------------------------------------------

typeset -gF _sprig_spawned_at=0

_sprig_start_daemon() {
  (( EPOCHREALTIME - _sprig_spawned_at < 3 )) && return
  _sprig_spawned_at=$EPOCHREALTIME
  _sprig_dbg "starting daemon"
  "${_sprig_cmd[@]}" daemon </dev/null >/dev/null 2>&1 &!
}

# Never waits: if the daemon isn't up yet, this keystroke just gets no dropdown.
_sprig_connect() {
  (( _sprig_fd >= 0 )) && return 0
  # Give up for this shell after repeated failures, so a broken install never costs anything.
  (( _sprig_failures > 20 )) && return 1
  if ! zsocket "$_sprig_sock" 2>/dev/null; then
    _sprig_dbg "connect failed ($_sprig_failures)"
    (( _sprig_failures++ ))
    _sprig_start_daemon
    return 1
  fi
  _sprig_fd=$REPLY
  _sprig_dbg "connected fd=$_sprig_fd"
  _sprig_failures=0
  zle -F -w $_sprig_fd _sprig_on_data
  _sprig_send_aliases
}

_sprig_disconnect() {
  (( _sprig_fd < 0 )) && return
  zle -F $_sprig_fd 2>/dev/null
  exec {_sprig_fd}>&-
  _sprig_fd=-1
}

# Write one message; reconnect once if the daemon went away.
_sprig_write() {
  setopt localoptions localtraps
  trap '' PIPE
  _sprig_connect || return 1
  if ! print -r -u $_sprig_fd -- "$1" 2>/dev/null; then
    _sprig_disconnect
    _sprig_connect && print -r -u $_sprig_fd -- "$1" 2>/dev/null
  fi
}

_sprig_send_aliases() {
  local msg=A k
  for k in ${(k)aliases}; do
    msg+=$'\x1f'"$k"$'\x1f'"${${aliases[$k]}//$'\n'/ }"
  done
  print -r -u $_sprig_fd -- "$msg" 2>/dev/null
}

# --- requests and responses --------------------------------------------------

# Ask for completions of LBUFFER if it changed. Pass "now" to ignore queued keys.
_sprig_request() {
  [[ $LBUFFER == $_sprig_sent ]] && return
  # More keys already waiting (fast typing, paste): ask once they're in.
  [[ $1 != now ]] && (( PENDING > 0 )) && return
  _sprig_sent=$LBUFFER
  if [[ -z ${LBUFFER//[[:space:]]/} ]]; then
    _sprig_hide
    return
  fi
  (( _sprig_id++ ))
  _sprig_dbg "send $_sprig_id [$LBUFFER]"
  _sprig_write "C"$'\x1f'$_sprig_id$'\x1f'$PWD$'\x1f'${LBUFFER//$'\n'/$'\x1e'}
}

# Take one reply line; returns 0 if it answers the latest request.
_sprig_apply() {
  local -a f
  f=("${(@ps:\x1f:)1}")
  _sprig_dbg "recv id=$f[2] want=$_sprig_id fields=$#f"
  [[ $f[1] == R && $f[2] == $_sprig_id ]] || return 1

  _sprig_shown_id=$f[2]
  _sprig_replace_len=$f[3]
  _sprig_spec=$f[4]
  _sprig_disp=() _sprig_ins=() _sprig_desc=() _sprig_kind=()
  local -i i
  for (( i = 5; i + 3 <= $#f; i += 4 )); do
    _sprig_disp+=("$f[i]") _sprig_ins+=("$f[i+1]") _sprig_desc+=("$f[i+2]") _sprig_kind+=("$f[i+3]")
  done
  _sprig_sel=0 _sprig_navigated=0

  # A description most rows share ("Branch") is noise: show only the ones that differ.
  (( $#_sprig_desc >= 3 )) || return 0
  local -A count
  local d common=""
  local -i best=0
  for d in "${_sprig_desc[@]}"; do
    [[ -z $d ]] && continue
    count[$d]=$(( ${count[$d]:-0} + 1 ))
    (( count[$d] > best )) && { best=$count[$d]; common=$d }
  done
  (( best * 2 > $#_sprig_desc )) || return 0
  for (( i = 1; i <= $#_sprig_desc; i++ )); do
    [[ $_sprig_desc[i] == $common ]] && _sprig_desc[i]=""
  done
  return 0
}

# zle -F handler: the daemon sent something.
_sprig_on_data() {
  local fd=$1 line
  local -i applied=0
  if ! read -r -u $fd line; then
    _sprig_disconnect
    _sprig_hide
    zle -R
    return
  fi
  _sprig_apply "$line" && applied=1
  while read -r -t 0 -u $fd line 2>/dev/null; do _sprig_apply "$line" && applied=1; done
  (( applied )) && [[ -n $LBUFFER ]] || return

  # Esc keeps the dropdown closed until a new word starts.
  local -i word_start=$(( ${#LBUFFER} - _sprig_replace_len ))
  if (( _sprig_dismissed_at >= 0 )); then
    (( word_start == _sprig_dismissed_at )) && { _sprig_hide; zle -R; return }
    _sprig_dismissed_at=-1
  fi

  _sprig_render
  zle -R
}

# --- drawing -----------------------------------------------------------------

_sprig_hide() {
  POSTDISPLAY=""
  (( $#_sprig_hl )) && region_highlight=("${(@)region_highlight:|_sprig_hl}")
  _sprig_hl=()
  _sprig_visible=0
}

_sprig_render() {
  _sprig_hide
  local -i n=$#_sprig_disp
  (( n )) || return

  local -i rows=$(( n < _sprig_max_rows ? n : _sprig_max_rows ))
  local -i top=$(( _sprig_sel >= rows ? _sprig_sel - rows + 1 : 0 ))
  local -i namew=0 i
  for (( i = top + 1; i <= top + rows; i++ )); do
    (( ${#_sprig_disp[i]} > namew )) && namew=${#_sprig_disp[i]}
  done
  (( namew > 40 )) && namew=40

  local -i width=$(( COLUMNS - 1 < 80 ? COLUMNS - 1 : 80 ))

  # Column of the word being completed, on its line.
  local before=${LBUFFER[1,-(_sprig_replace_len+1)]}
  (( _sprig_replace_len == 0 )) && before=$LBUFFER
  local -i col=${#${before##*$'\n'}}
  [[ $before != *$'\n'* ]] && col+=_sprig_prompt_col
  # Popup is only as wide as its content.
  local -i descw=0 avail=$(( width - namew - 6 ))
  for (( i = top + 1; i <= top + rows; i++ )); do
    (( ${#_sprig_desc[i]} > descw )) && descw=${#_sprig_desc[i]}
  done
  (( descw > avail )) && descw=$avail
  (( avail > 10 )) || descw=0
  local -i boxw=$(( namew + 4 ))
  (( descw )) && boxw+=$(( descw + 2 ))
  (( col + boxw > COLUMNS - 1 )) && col=$(( COLUMNS - 1 - boxw ))
  (( col < 0 )) && col=0
  local pad=${(l:col:: :)}

  local text="" line name desc kind icon sfx=""
  (( _sprig_memo )) && sfx=" memo=sprig"
  local -i base=$#BUFFER start
  local -a hl
  for (( i = top + 1; i <= top + rows; i++ )); do
    name=${_sprig_disp[i][1,namew]}
    kind=$_sprig_kind[i]
    icon=${_sprig_icon[$kind]:-•}
    if (( descw )); then
      desc=${_sprig_desc[i][1,descw]}
      line=" $icon ${(r:namew:: :)name}  ${(r:descw:: :)desc} "
    else
      line=" $icon ${(r:namew:: :)name} "
    fi
    text+=$'\n'$pad
    start=$(( base + ${#text} ))
    text+=$line
    if (( i == _sprig_sel + 1 )); then
      hl+=("$start $(( start + ${#line} )) fg=255,bg=25,bold$sfx")
    else
      hl+=("$start $(( start + 3 )) fg=${_sprig_icon_color[$kind]:-250},bg=236$sfx")
      hl+=("$(( start + 3 )) $(( start + 4 + namew )) fg=254,bg=236$sfx")
      hl+=("$(( start + 4 + namew )) $(( start + ${#line} )) fg=244,bg=236$sfx")
    fi
  done
  if (( n > rows )); then
    # Footer sits inside the box: position on the left, keys on the right.
    local pos=" $(( _sprig_sel + 1 ))/$n" keys="↑↓ tab "
    if (( boxw >= ${#pos} + ${#keys} + 1 )); then
      line=$pos${(l:boxw-${#pos}:: :)keys}
    else
      line=${(r:boxw:: :)pos}
    fi
    text+=$'\n'$pad
    start=$(( base + ${#text} ))
    text+=$line
    hl+=("$start $(( start + ${#line} )) fg=242,bg=236$sfx")
  fi

  POSTDISPLAY=$text
  _sprig_hl=("${hl[@]}")
  region_highlight+=("${hl[@]}")
  _sprig_visible=1
}

# --- zle hooks ---------------------------------------------------------------

# Find where the prompt ends by asking the terminal for the cursor position.
_sprig_line_init() {
  setopt localoptions extendedglob
  _sprig_sent="" _sprig_dismissed_at=-1
  _sprig_prompt_col=0
  [[ -n $SPRIG_NO_DSR ]] && return
  local reply="" c
  print -n $'\e[6n' > /dev/tty
  while read -rs -k1 -t 0.15 c < /dev/tty; do
    reply+=$c
    [[ $reply == *$'\e['[0-9]##';'[0-9]##R ]] && break
  done
  if [[ $reply == (#b)(*)$'\e['([0-9]##)';'([0-9]##)R ]]; then
    _sprig_prompt_col=$(( match[3] - 1 ))
    reply=$match[1]
  fi
  # Keys typed while waiting for the answer go back into the input queue.
  [[ -n $reply ]] && zle -U -- "$reply"
}

_sprig_pre_redraw() {
  _sprig_dbg "pre-redraw [$LBUFFER] pending=$PENDING"
  _sprig_request
}

_sprig_line_finish() {
  _sprig_hide
  _sprig_sent=""
  # Replies still in flight belong to the line just finished.
  (( _sprig_id++ ))
}

# --- key widgets -------------------------------------------------------------

# Widgets the keys were bound to before sprig, called when the dropdown is closed.
typeset -gA _sprig_orig

_sprig_call_orig() {
  local w=${_sprig_orig[$1]:-$2}
  zle "$w"
}

_sprig_down() {
  if (( _sprig_visible )); then
    _sprig_sel=$(( (_sprig_sel + 1) % $#_sprig_disp )); _sprig_navigated=1; _sprig_render
  else
    _sprig_call_orig down down-line-or-history
  fi
}

_sprig_up() {
  if (( _sprig_visible )); then
    _sprig_sel=$(( (_sprig_sel - 1 + $#_sprig_disp) % $#_sprig_disp )); _sprig_navigated=1; _sprig_render
  else
    _sprig_call_orig up up-line-or-history
  fi
}

_sprig_insert_selected() {
  local ins=$_sprig_ins[_sprig_sel+1]
  if (( _sprig_replace_len > 0 )); then
    LBUFFER="${LBUFFER[1,-(_sprig_replace_len+1)]}$ins"
  else
    LBUFFER+=$ins
  fi
  [[ -n $_sprig_spec ]] && _sprig_write "U"$'\x1f'$_sprig_spec$'\x1f'$ins
  _sprig_hide
}

# Block briefly for the reply to the latest request (Tab pressed faster than replies).
_sprig_wait_fresh() {
  (( _sprig_shown_id == _sprig_id )) && return 0
  (( _sprig_fd >= 0 )) || return 1
  local line
  local -F deadline=$(( EPOCHREALTIME + 0.3 ))
  while (( _sprig_shown_id != _sprig_id && EPOCHREALTIME < deadline )); do
    read -r -t 0.3 -u $_sprig_fd line || return 1
    _sprig_apply "$line"
  done
  (( _sprig_shown_id == _sprig_id ))
}

_sprig_tab() {
  # The dropdown may show results for a shorter word if keys came in fast.
  if (( _sprig_visible )) || [[ $LBUFFER != $_sprig_sent && -n ${LBUFFER//[[:space:]]/} ]]; then
    _sprig_request now
    if _sprig_wait_fresh && (( $#_sprig_disp && _sprig_dismissed_at < 0 )); then
      _sprig_insert_selected
      return
    fi
  fi
  _sprig_call_orig tab expand-or-complete
}

_sprig_shift_tab() {
  if (( _sprig_visible )); then
    _sprig_up
  else
    _sprig_call_orig shifttab reverse-menu-complete
  fi
}

_sprig_enter() {
  # While the dropdown is open, Enter inserts the highlighted item, then runs the line.
  if (( _sprig_visible )); then
    _sprig_request now
    _sprig_wait_fresh && (( $#_sprig_disp && _sprig_dismissed_at < 0 )) && _sprig_insert_selected
  fi
  _sprig_hide
  _sprig_call_orig enter accept-line
}

_sprig_escape() {
  if (( _sprig_visible )); then
    _sprig_dismissed_at=$(( ${#LBUFFER} - _sprig_replace_len ))
    _sprig_hide
  else
    _sprig_call_orig escape vi-cmd-mode
  fi
}

# Start the daemon with the shell so it's warm by the first keystroke.
[[ -S $_sprig_sock ]] || _sprig_start_daemon

zle -N _sprig_on_data
zle -N _sprig_down
zle -N _sprig_up
zle -N _sprig_tab
zle -N _sprig_shift_tab
zle -N _sprig_enter
zle -N _sprig_escape
add-zle-hook-widget line-init _sprig_line_init
add-zle-hook-widget line-pre-redraw _sprig_pre_redraw
add-zle-hook-widget line-finish _sprig_line_finish

# Clear the dropdown when Ctrl-C abandons the line. Traps can't touch
# POSTDISPLAY directly, but they can run a widget (like clock prompts do).
_sprig_clear() {
  _sprig_hide
  (( _sprig_id++ ))
  zle -R
}
zle -N _sprig_clear
(( ${+functions[TRAPINT]} )) && [[ $functions[TRAPINT] != *_sprig_* ]] && functions[_sprig_user_trapint]=$functions[TRAPINT]
TRAPINT() {
  zle && (( _sprig_visible )) && zle _sprig_clear
  (( ${+functions[_sprig_user_trapint]} )) && { _sprig_user_trapint "$@"; return }
  return $(( 128 + $1 ))
}

() {
  local km k name widget
  local -A keys=(
    down  "^[[B ^[OB ${terminfo[kcud1]} ^N"
    up    "^[[A ^[OA ${terminfo[kcuu1]} ^P"
    tab   "^I"
    shifttab "^[[Z ${terminfo[kcbt]}"
    enter "^M"
  )
  local -A widgets=(down _sprig_down up _sprig_up tab _sprig_tab shifttab _sprig_shift_tab enter _sprig_enter)
  for km in emacs viins; do
    for name in ${(k)keys}; do
      for k in ${=keys[$name]}; do
        [[ -z $k ]] && continue
        widget=${${(z)$(bindkey -M $km -- "$k" 2>/dev/null)}[2]}
        [[ $widget == _sprig_* ]] && continue
        [[ -n $widget && $widget != undefined-key && $km == emacs ]] && : ${_sprig_orig[$name]:=$widget}
        bindkey -M $km -- "$k" ${widgets[$name]}
      done
    done
  done
  # Lone Esc: emacs keymap only; in vi mode Esc must stay vi-cmd-mode.
  _sprig_orig[escape]=${${(z)$(bindkey -M emacs '^[' 2>/dev/null)}[2]}
  [[ $_sprig_orig[escape] == (undefined-key|) ]] && _sprig_orig[escape]=undefined-key
  bindkey -M emacs '^[' _sprig_escape
}
