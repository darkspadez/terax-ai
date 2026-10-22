# terax-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _terax_wrapper_zdotdir="$ZDOTDIR"
  _terax_had_wrapper_zdotdir="${ZDOTDIR+x}"
  if [ -n "${TERAX_USER_ZDOTDIR+x}" ]; then
    export ZDOTDIR="$TERAX_USER_ZDOTDIR"
  else
    unset ZDOTDIR
  fi
  _terax_user_zdotdir="${ZDOTDIR:-$HOME}"
  if [ -n "$_terax_wrapper_zdotdir" ] && [ "${HISTFILE:-}" = "$_terax_wrapper_zdotdir/.zsh_history" ]; then
    HISTFILE="$_terax_user_zdotdir/.zsh_history"
  fi
  [ -f "$_terax_user_zdotdir/.zprofile" ] && source "$_terax_user_zdotdir/.zprofile"
  if [ -n "${ZDOTDIR+x}" ]; then
    export TERAX_USER_ZDOTDIR="$ZDOTDIR"
  else
    unset TERAX_USER_ZDOTDIR
  fi
  if [ -n "$_terax_had_wrapper_zdotdir" ]; then
    export ZDOTDIR="$_terax_wrapper_zdotdir"
  else
    unset ZDOTDIR
  fi
  unset _terax_wrapper_zdotdir _terax_had_wrapper_zdotdir _terax_user_zdotdir
}
:
