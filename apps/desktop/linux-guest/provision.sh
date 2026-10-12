#!/bin/sh
# Space Bench: turn a fresh Debian 13 (trixie) arm64 VM into the Raspberry Pi system the Linux
# boards run. Run once as root on the VM's console; Space Bench copies the files next to this
# script into /root/spacebench first. Progress lines: "SB-STEP n/N text"; the end: "SB-DONE …"
# or "SB-FAIL …".
set -e
N=9
step() { echo "SB-STEP $1/$N $2"; }
fail() { echo "SB-FAIL $*"; exit 1; }
trap 'echo "SB-FAIL line $LINENO"' EXIT
export DEBIAN_FRONTEND=noninteractive
KV=$(uname -r)
SRC=/root/spacebench

step 1 "Updating the package lists"
apt-get update -qq

step 2 "Installing the compiler and Linux headers"
apt-get install -y -qq build-essential "linux-headers-$KV" curl gnupg sudo gpiod python3-libgpiod python3-pip python3-venv i2c-tools >/dev/null

step 3 "Adding the Raspberry Pi package archive"
curl -fsSLo /tmp/rpi-keyring.deb http://archive.raspberrypi.com/debian/pool/main/r/raspberrypi-archive-keyring/raspberrypi-archive-keyring_2025.1+rpt1_all.deb
dpkg -i /tmp/rpi-keyring.deb >/dev/null
echo "deb [signed-by=/usr/share/keyrings/raspberrypi-archive-keyring.pgp] http://archive.raspberrypi.com/debian trixie main" > /etc/apt/sources.list.d/raspi.list
apt-get update -qq

step 4 "Installing gpiozero, lgpio and RPi.GPIO (rpi-lgpio)"
apt-get install -y -qq python3-gpiozero python3-lgpio python3-rpi-lgpio >/dev/null

step 5 "Building the simulated GPIO driver (gpio-sim) for kernel $KV"
# Debian's kernel doesn't build gpio-sim or the irq_sim helper it needs: build both, from the
# kernel.org sources of this exact version, as one module
TAG="v$(echo "$KV" | sed 's/+.*//; s/-.*//')"
mkdir -p /usr/src/gpio-sim && cd /usr/src/gpio-sim
curl -fsSL -o gpio-sim-main.c "https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/drivers/gpio/gpio-sim.c?h=$TAG"
curl -fsSL -o irq_sim.c "https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/kernel/irq/irq_sim.c?h=$TAG"
# irq_to_desc isn't exported to modules; generic_handle_irq does the same through the flow handler
sed -i 's/handle_simple_irq(irq_to_desc(irqnum));/generic_handle_irq(irqnum);/' irq_sim.c
printf 'obj-m += gpio-sim.o\ngpio-sim-objs := gpio-sim-main.o irq_sim.o\n' > Makefile
make -s -C "/lib/modules/$KV/build" M="$PWD" modules 2>&1 | grep -v 'Skipping BTF' || true
[ -f gpio-sim.ko ] || fail "gpio-sim did not build"
mkdir -p "/lib/modules/$KV/extra" && cp gpio-sim.ko "/lib/modules/$KV/extra/" && depmod -a "$KV"
modprobe gpio-sim || fail "gpio-sim did not load"
# the module is built for this kernel: keep it
apt-mark hold linux-image-arm64 "linux-image-$KV" linux-headers-arm64 "linux-headers-$KV" >/dev/null

step 6 "Installing the Space Bench agent and services"
# (the camera / microphone feeders and their add-on installer are used only when a project asks)
install -m 755 "$SRC/spacebench-agent" "$SRC/spacebench-identity" "$SRC/spacebench-gpio-setup" "$SRC/spacebench-camera" "$SRC/spacebench-mic" "$SRC/spacebench-media-setup" /usr/local/sbin/
install -m 644 "$SRC/spacebench-identity.service" "$SRC/spacebench-gpio.service" "$SRC/spacebench-agent.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable spacebench-identity.service spacebench-gpio.service spacebench-agent.service >/dev/null 2>&1

step 7 "Creating the pi user"
groupadd -f gpio; groupadd -f i2c; groupadd -f spi
# like Raspberry Pi OS: the gpio group may use the GPIO chips
echo 'SUBSYSTEM=="gpio", KERNEL=="gpiochip*", GROUP="gpio", MODE="0660"' > /etc/udev/rules.d/60-spacebench-gpio.rules
id pi >/dev/null 2>&1 || useradd -m -s /bin/bash -G gpio,i2c,spi,dialout,sudo,video,audio pi
passwd -d pi >/dev/null
echo "pi ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_pi-nopasswd && chmod 440 /etc/sudoers.d/010_pi-nopasswd
hostnamectl set-hostname raspberrypi 2>/dev/null || echo raspberrypi > /etc/hostname
sed -i 's/^127.0.1.1.*/127.0.1.1\traspberrypi/' /etc/hosts; grep -q raspberrypi /etc/hosts || echo "127.0.1.1	raspberrypi" >> /etc/hosts
# the console logs in as pi (the Terminal); root keeps its password
mkdir -p /etc/systemd/system/serial-getty@ttyAMA0.service.d
printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin pi --noclear --keep-baud 115200,57600,38400,9600 %%I $TERM\n' > /etc/systemd/system/serial-getty@ttyAMA0.service.d/autologin.conf
cat > /home/pi/main.py <<'EOF'
# Runs on the Raspberry Pi in Space Bench. GPIO17 drives an LED through a resistor.
from gpiozero import LED
from time import sleep

led = LED(17)
while True:
    led.toggle()
    sleep(0.5)
EOF
chown pi:pi /home/pi/main.py

step 8 "Cleaning up"
apt-get clean
rm -f /tmp/rpi-keyring.deb

step 9 "Starting the agent"
systemctl start spacebench-identity.service spacebench-gpio.service
systemctl restart spacebench-agent.service || true
trap - EXIT
ROOT=$(findmnt -no PARTUUID /)
echo "SB-DONE kernel=/boot/vmlinuz-$KV initrd=/boot/initrd.img-$KV root=PARTUUID=$ROOT"
