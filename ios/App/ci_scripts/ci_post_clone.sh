#!/bin/sh
# Xcode Cloud: runs right after the repo is cloned, before xcodebuild.
#
# The iOS project is NOT buildable from a bare clone — the web bundle
# (ios/App/App/public) and the Pods are gitignored — so this does what a local
# `npm run ios:build:prod` does: install Node + CocoaPods, build the web app against
# the hosted backend, and `cap sync ios` (which copies the bundle and runs pod install).
#
# The backend comes from the workflow's ENVIRONMENT VARIABLES (App Store Connect →
# Xcode Cloud → workflow → Environment), not from the gitignored .env.deploy:
#   VITE_SUPABASE_URL       required  https://<ref>.supabase.co
#   VITE_SUPABASE_ANON_KEY  required  the PUBLISHABLE key (public; RLS protects data)
#   other VITE_* (VITE_APPLE_SIGNIN, VITE_LESSONS_URL, …) pass straight through to Vite.
set -eu

cd "$CI_PRIMARY_REPOSITORY_PATH"

# Homebrew is preinstalled on Xcode Cloud images; Node and CocoaPods are not.
export HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_AUTO_UPDATE=1
brew install node cocoapods
echo "node $(node -v) · npm $(npm -v) · pod $(pod --version)"

npm ci
bash scripts/build-ios.sh --from-env
