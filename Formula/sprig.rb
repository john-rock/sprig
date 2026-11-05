# Homebrew formula. Publish it in a tap repo named `homebrew-sprig`, then:
#   brew install john-rock/sprig/sprig && sprig install
#
# Fill in the sha256 values from dist/SHA256SUMS after running
# scripts/build.sh and uploading the tarballs to a GitHub release.
class Sprig < Formula
  desc "Fig-style IDE autocomplete for zsh, powered by Fig's completion specs"
  homepage "https://github.com/john-rock/sprig"
  version "0.1.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/john-rock/sprig/releases/download/v#{version}/sprig-#{version}-darwin-arm64.tar.gz"
      sha256 "REPLACE_ME"
    end
    on_intel do
      url "https://github.com/john-rock/sprig/releases/download/v#{version}/sprig-#{version}-darwin-x64.tar.gz"
      sha256 "REPLACE_ME"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/john-rock/sprig/releases/download/v#{version}/sprig-#{version}-linux-arm64.tar.gz"
      sha256 "REPLACE_ME"
    end
    on_intel do
      url "https://github.com/john-rock/sprig/releases/download/v#{version}/sprig-#{version}-linux-x64.tar.gz"
      sha256 "REPLACE_ME"
    end
  end

  def install
    bin.install "bin/sprig"
    (share/"sprig").install "share/sprig/specs"
    doc.install Dir["share/doc/sprig/*"]
  end

  def caveats
    <<~EOS
      Finish setup with:
        sprig install
      then open a new terminal tab.
    EOS
  end

  test do
    assert_match "checkout", shell_output("#{bin}/sprig complete 'git ch'")
  end
end
