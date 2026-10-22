# terax-shell-integration (zshenv)
#
# Trailing `:` is load-bearing — without it, a missing user .zshenv leaves $?=1,
# which propagates through the rest of init and ultimately into the first
# prompt's `%?` (rendering robbyrussell's `➜` red on a clean shell start).
#
# Every wrapper sources the user's file under the user's own ZDOTDIR (or none),
# so `$ZDOTDIR/conf.d/*` and `${ZDOTDIR:-$HOME}/.zsh_history` resolve as in any
# terminal. A ZDOTDIR the user's file sets is carried in TERAX_USER_ZDOTDIR, and
# ZDOTDIR points back here afterwards so zsh still loads the next wrapper. A
# HISTFILE derived from this directory (macOS /etc/zshrc) moves to the user's.
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
  [ -f "$_terax_user_zdotdir/.zshenv" ] && source "$_terax_user_zdotdir/.zshenv"
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
